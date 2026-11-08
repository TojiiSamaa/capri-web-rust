//! Capri's built-in tools: time, weather, news, sums, Wikipedia and reminders, there without any setup. External URLs
//! are fixed here, never from the caller. They are reached through the same MCP tool flow as the servers in mcp.json.
use crate::calc::{calculate, convert, unit_names};
use crate::store::Store;
use crate::util::{finite, js_num, js_round, js_trim, len16, slice16};
use chrono::{DateTime, Datelike, Local, NaiveDateTime, Offset, TimeZone, Timelike, Utc};
use chrono_tz::Tz;
use regex::{Regex, RegexBuilder};
use serde_json::{json, Map, Value};
use std::sync::OnceLock;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CITY: usize = 100;
const NEWS_ITEMS: usize = 8;
const FEEDS: [(&str, &str); 2] = [("fr", "https://www.france24.com/fr/rss"), ("en", "https://www.france24.com/en/rss")];
const WIKIS: [(&str, &str); 2] = [("fr", "https://fr.wikipedia.org"), ("en", "https://en.wikipedia.org")];
const WIKI_AGENT: &str = "Capri/0.1 (assistant local)"; // Wikimedia refuses clients without one
const MAX_SUBJECT: usize = 200;
const MAX_EXTRACT: usize = 2000;
const MAX_REMINDER: usize = 300;
const MAX_REMINDERS: usize = 100;
const YEAR: f64 = 365.0 * 24.0 * 60.0 * 60_000.0;

const SKY: [(i64, &str); 28] = [
    (0, "ciel dégagé"), (1, "plutôt dégagé"), (2, "partiellement nuageux"), (3, "couvert"), (45, "brouillard"), (48, "brouillard givrant"),
    (51, "bruine légère"), (53, "bruine"), (55, "bruine forte"), (56, "bruine verglaçante"), (57, "bruine verglaçante forte"),
    (61, "pluie faible"), (63, "pluie modérée"), (65, "pluie forte"), (66, "pluie verglaçante"), (67, "pluie verglaçante forte"),
    (71, "neige faible"), (73, "neige modérée"), (75, "neige forte"), (77, "grains de neige"),
    (80, "averses faibles"), (81, "averses"), (82, "averses violentes"), (85, "averses de neige"), (86, "fortes averses de neige"),
    (95, "orage"), (96, "orage avec grêle"), (99, "orage avec forte grêle"),
];

fn sky(code: f64) -> String {
    SKY.iter().find(|(c, _)| *c as f64 == code).map(|(_, s)| s.to_string()).unwrap_or_else(|| format!("code météo {}", js_num(code)))
}

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("http client"))
}

// ---- Dates, in French as Intl writes them ----

const WEEKDAYS: [&str; 7] = ["lundi", "mardi", "mercredi", "jeudi", "vendredi", "samedi", "dimanche"];
const MONTHS: [&str; 12] = ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"];

fn fr_date<T: TimeZone>(at: &DateTime<T>) -> String {
    format!("{} {} {} {} à {:02}:{:02}", WEEKDAYS[at.weekday().num_days_from_monday() as usize], at.day(), MONTHS[at.month0() as usize], at.year(), at.hour(), at.minute())
}

fn local_zone() -> Tz {
    iana_time_zone::get_timezone().ok().and_then(|n| n.parse().ok()).unwrap_or(Tz::UTC)
}

pub fn time_in(zone: Option<&Value>, now: DateTime<Utc>) -> Result<String, String> {
    let name = match zone {
        None => String::new(),
        Some(Value::String(s)) => js_trim(s).to_string(),
        Some(_) => return Err("Le fuseau doit être un nom comme Europe/Paris.".into()),
    };
    let tz: Tz = if name.is_empty() { local_zone() } else { name.parse().map_err(|_| format!("Fuseau inconnu : {name}. Il faut un nom comme Europe/Paris."))? };
    let at = now.with_timezone(&tz);
    let minutes = at.offset().fix().local_minus_utc() / 60;
    let offset = format!("UTC{}{:02}:{:02}", if minutes < 0 { '\u{2212}' } else { '+' }, minutes.abs() / 60, minutes.abs() % 60);
    Ok(format!("{} {offset} ({})", fr_date(&at), tz.name()))
}

fn shown_date(at_ms: i64) -> String {
    fr_date(&Local.timestamp_millis_opt(at_ms).unwrap())
}

// ---- Weather ----

pub fn parse_place(answer: &Value) -> Option<(f64, f64, String)> {
    let place = answer.pointer("/results/0")?;
    let (lat, lon) = (finite(place.get("latitude"))?, finite(place.get("longitude"))?);
    let label = ["name", "admin1", "country"].iter().filter_map(|k| place.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty())).collect::<Vec<_>>().join(", ");
    Some((lat, lon, label))
}

/// Refuses a partial answer rather than show a value nobody measured.
pub fn parse_forecast(answer: &Value) -> Result<String, String> {
    let incomplete = || "Open-Meteo a envoyé une réponse incomplète.".to_string();
    let (c, d) = (&answer["current"], &answer["daily"]);
    let m = |k: &str| finite(c.get(k));
    let (Some(temp), Some(feels), Some(humidity), Some(rain), Some(code), Some(wind)) = (m("temperature_2m"), m("apparent_temperature"), m("relative_humidity_2m"), m("precipitation"), m("weather_code"), m("wind_speed_10m")) else { return Err(incomplete()) };
    let days = d.get("time").and_then(Value::as_array).filter(|t| !t.is_empty()).ok_or_else(incomplete)?;
    let time = c.get("time").and_then(Value::as_str).unwrap_or("undefined");
    let now = format!("Maintenant ({time}, heure locale) : {} °C, ressenti {} °C, {}, humidité {} %, précipitations {} mm, vent {} km/h.", js_num(temp), js_num(feels), sky(code), js_num(humidity), js_num(rain), js_num(wind));
    let mut lines = vec![now];
    for (i, day) in days.iter().enumerate() {
        let at = |k: &str| finite(d.get(k).and_then(|a| a.get(i)));
        let (Some(code), Some(min), Some(max)) = (at("weather_code"), at("temperature_2m_min"), at("temperature_2m_max")) else { return Err(incomplete()) };
        let chance = at("precipitation_probability_max").map(|r| format!(", risque de précipitations {} %", js_num(r))).unwrap_or_default();
        lines.push(format!("{} : {}, {} à {} °C{chance}.", day.as_str().unwrap_or("undefined"), sky(code), js_num(min), js_num(max)));
    }
    Ok(lines.join("\n"))
}

// ---- News ----

fn plain(raw: &str) -> String {
    static CDATA: OnceLock<Regex> = OnceLock::new();
    static ENTITY: OnceLock<Regex> = OnceLock::new();
    static TAG: OnceLock<Regex> = OnceLock::new();
    static SPACES: OnceLock<Regex> = OnceLock::new();
    let cdata = CDATA.get_or_init(|| Regex::new(r"(?s)<!\[CDATA\[(.*?)\]\]>").unwrap());
    let entity = ENTITY.get_or_init(|| RegexBuilder::new(r"&(#\d+|#x[\da-f]+|\w+);").case_insensitive(true).build().unwrap());
    let tag = TAG.get_or_init(|| Regex::new(r"<[^>]*>").unwrap());
    let spaces = SPACES.get_or_init(|| Regex::new(r"\s+").unwrap());
    let text = cdata.replace_all(raw, "$1");
    let decoded = entity.replace_all(&text, |c: &regex::Captures| {
        let code = &c[1];
        if !code.starts_with('#') {
            return match code {
                "amp" => "&".to_string(),
                "lt" => "<".to_string(),
                "gt" => ">".to_string(),
                "quot" => "\"".to_string(),
                "apos" => "'".to_string(),
                "nbsp" => " ".to_string(),
                _ => c[0].to_string(),
            };
        }
        let n = if code[1..].starts_with(['x', 'X']) { u32::from_str_radix(&code[2..], 16).ok() } else { code[1..].parse().ok() };
        n.and_then(char::from_u32).map(String::from).unwrap_or_default()
    });
    let no_tags = tag.replace_all(&decoded, " ");
    js_trim(&spaces.replace_all(&no_tags, " ")).to_string()
}

#[derive(Debug, PartialEq)]
pub struct Item {
    pub title: String,
    pub link: String,
    pub summary: String,
    pub date: String,
}

fn feed_date(text: &str) -> String {
    let parsed = DateTime::parse_from_rfc2822(text).or_else(|_| DateTime::parse_from_rfc3339(text)).ok();
    parsed.map(|d| d.with_timezone(&Utc).format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()).unwrap_or_default()
}

pub fn parse_feed(xml: &str, max: usize) -> Result<Vec<Item>, String> {
    static ITEM: OnceLock<Regex> = OnceLock::new();
    let item_re = ITEM.get_or_init(|| Regex::new(r"(?s)<item[\s>].*?</item>").unwrap());
    let field = |item: &str, tag: &str| {
        let re = Regex::new(&format!(r"(?s)<{tag}(?:\s[^>]*)?>(.*?)</{tag}>")).unwrap();
        re.captures(item).map(|c| plain(&c[1])).unwrap_or_default()
    };
    let mut items = Vec::new();
    for m in item_re.find_iter(xml) {
        let (title, link) = (field(m.as_str(), "title"), field(m.as_str(), "link"));
        if title.is_empty() || !(link.starts_with("http://") || link.starts_with("https://")) {
            continue;
        }
        items.push(Item { title, link, summary: slice16(&field(m.as_str(), "description"), 300), date: feed_date(&field(m.as_str(), "pubDate")) });
        if items.len() == max {
            break;
        }
    }
    if items.is_empty() {
        return Err("Le flux d'actualités ne contient aucun article lisible.".into());
    }
    Ok(items)
}

async fn fetched(url: &str, query: &[(&str, String)], source: &str, agent: Option<&str>) -> Result<reqwest::Response, String> {
    let mut request = http().get(url).query(query).timeout(TIMEOUT);
    if let Some(a) = agent {
        request = request.header("User-Agent", a);
    }
    let failed = |why: String| format!("{source} ne répond pas ({why}).");
    let res = request.send().await.map_err(|e| failed(e.to_string()))?;
    if !res.status().is_success() {
        return Err(failed(format!("réponse {}", res.status().as_u16())));
    }
    Ok(res)
}

fn bad_text(value: &Value, most: usize) -> Option<String> {
    let s = value.as_str()?;
    (!js_trim(s).is_empty() && len16(s) <= most && !s.chars().any(|c| c < ' ')).then(|| js_trim(s).to_string())
}

async fn weather(city: Option<&Value>) -> Result<String, String> {
    let Some(city) = city.and_then(|c| bad_text(c, MAX_CITY)) else { return Err(format!("Il faut un nom de ville de {MAX_CITY} caractères maximum.")) };
    // Only the city name and its coordinates leave this machine.
    let search = [("name", city.clone()), ("count", "1".into()), ("language", "fr".into()), ("format", "json".into())];
    let found: Value = fetched("https://geocoding-api.open-meteo.com/v1/search", &search, "Open-Meteo", None).await?.json().await.map_err(|e| format!("Open-Meteo ne répond pas ({e})."))?;
    let Some((latitude, longitude, label)) = parse_place(&found) else { return Err(format!("Ville introuvable : {city}.")) };
    let query = [
        ("latitude", js_num(latitude)),
        ("longitude", js_num(longitude)),
        ("current", "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m".into()),
        ("daily", "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max".into()),
        ("timezone", "auto".into()),
        ("forecast_days", "7".into()),
    ];
    let forecast: Value = fetched("https://api.open-meteo.com/v1/forecast", &query, "Open-Meteo", None).await?.json().await.map_err(|e| format!("Open-Meteo ne répond pas ({e})."))?;
    Ok(format!("{label}\n{}\nSource : Open-Meteo.", parse_forecast(&forecast)?))
}

fn pick<'a>(table: &[(&str, &'a str)], key: &str) -> Option<&'a str> {
    table.iter().find(|(k, _)| *k == key).map(|(_, v)| *v)
}

async fn news(language: Option<&Value>) -> Result<String, String> {
    let fr = json!("fr");
    let lang = language.unwrap_or(&fr);
    let Some(feed) = lang.as_str().and_then(|l| pick(&FEEDS, l)) else { return Err("La langue doit être fr ou en.".into()) };
    let xml = fetched(feed, &[], "France 24", None).await?.text().await.map_err(|e| format!("France 24 ne répond pas ({e})."))?;
    let mut lines: Vec<String> = parse_feed(&xml, NEWS_ITEMS)?
        .iter()
        .map(|i| format!("- {}{}{}\n  {}", i.title, if i.date.is_empty() { String::new() } else { format!(" ({})", i.date) }, if i.summary.is_empty() { String::new() } else { format!("\n  {}", i.summary) }, i.link))
        .collect();
    lines.push("Source : France 24.".into());
    Ok(lines.join("\n"))
}

// ---- Wikipedia ----

pub fn parse_summary(answer: &Value) -> Result<String, String> {
    let extract = answer.get("extract").and_then(Value::as_str).filter(|e| !js_trim(e).is_empty()).ok_or("Wikipédia a envoyé une réponse incomplète.")?;
    if answer.get("type").and_then(Value::as_str) == Some("disambiguation") {
        return Err(format!("« {} » a plusieurs sens sur Wikipédia : il faut préciser le sujet.", answer.get("title").and_then(Value::as_str).unwrap_or("undefined")));
    }
    let mut lines = vec![answer.get("title").and_then(Value::as_str).unwrap_or("undefined").to_string(), slice16(js_trim(extract), MAX_EXTRACT)];
    if let Some(page) = answer.pointer("/content_urls/desktop/page").and_then(Value::as_str).filter(|p| p.starts_with("https://")) {
        lines.push(page.to_string());
    }
    lines.push("Source : Wikipédia (CC BY-SA).".into());
    Ok(lines.join("\n"))
}

async fn wikipedia(subject: Option<&Value>, language: Option<&Value>) -> Result<String, String> {
    let Some(subject) = subject.and_then(|s| bad_text(s, MAX_SUBJECT)) else { return Err(format!("Il faut un sujet de {MAX_SUBJECT} caractères maximum.")) };
    let fr = json!("fr");
    let lang = language.unwrap_or(&fr);
    let Some(base) = lang.as_str().and_then(|l| pick(&WIKIS, l)) else { return Err("La langue doit être fr ou en.".into()) };
    let search = [("q", subject.clone()), ("limit", "1".into())];
    let found: Value = fetched(&format!("{base}/w/rest.php/v1/search/page"), &search, "Wikipédia", Some(WIKI_AGENT)).await?.json().await.map_err(|e| format!("Wikipédia ne répond pas ({e})."))?;
    let Some(key) = found.pointer("/pages/0/key").and_then(Value::as_str) else { return Err(format!("Rien sur Wikipédia pour : {subject}.")) };
    let summary: Value = fetched(&format!("{base}/api/rest_v1/page/summary/{}", crate::util::encode_uri_component(key)), &[], "Wikipédia", Some(WIKI_AGENT)).await?.json().await.map_err(|e| format!("Wikipédia ne répond pas ({e})."))?;
    parse_summary(&summary)
}

// ---- Reminders ----

pub fn reminder_time(minutes: Option<&Value>, date: Option<&Value>, now: f64) -> Result<i64, String> {
    if minutes.is_none() == date.is_none() {
        return Err("Il faut soit dans_minutes, soit a.".into());
    }
    let at = if let Some(m) = minutes {
        let m = m.as_f64().filter(|m| m.is_finite()).ok_or("dans_minutes doit être un nombre.")?;
        now + m * 60_000.0
    } else {
        let wrong = || "a doit être une date comme 2026-11-05T18:30.".to_string();
        let text = date.and_then(Value::as_str).filter(|d| Regex::new(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}").unwrap().is_match(d)).ok_or_else(wrong)?;
        // Without an offset this is local time, which is what the person means.
        let parsed = DateTime::parse_from_rfc3339(text).map(|d| d.timestamp_millis()).ok().or_else(|| {
            ["%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%dT%H:%M"].iter().find_map(|f| NaiveDateTime::parse_and_remainder(text, f).ok().filter(|(_, rest)| rest.is_empty()).map(|(n, _)| n)).and_then(|n| Local.from_local_datetime(&n).earliest()).map(|d| d.timestamp_millis())
        });
        parsed.ok_or_else(wrong)? as f64
    };
    if at <= now {
        return Err("Ce moment est déjà passé.".into());
    }
    if at > now + YEAR {
        return Err("Un rappel se règle à un an maximum.".into());
    }
    Ok(js_round(at) as i64)
}

fn add_reminder(store: &Store, args: &Map<String, Value>) -> Result<String, String> {
    let Some(text) = args.get("texte").and_then(|t| bad_text(t, MAX_REMINDER)) else { return Err(format!("Il faut un texte de {MAX_REMINDER} caractères maximum.")) };
    let at = reminder_time(args.get("dans_minutes"), args.get("a"), crate::store::now_ms() as f64)?;
    if store.reminders().len() >= MAX_REMINDERS {
        return Err(format!("Il y a déjà {MAX_REMINDERS} rappels en attente."));
    }
    let id = store.add_reminder(&text, at).map_err(|e| e.to_string())?;
    Ok(format!("Rappel n° {id} prévu le {} : {text}", shown_date(at)))
}

fn list_reminders(store: &Store) -> String {
    let waiting = store.reminders();
    if waiting.is_empty() {
        return "Aucun rappel en attente.".into();
    }
    waiting.iter().map(|r| format!("n° {}, le {} : {}", r.id, shown_date(r.at), r.text)).collect::<Vec<_>>().join("\n")
}

fn cancel_reminder(store: &Store, id: Option<&Value>) -> Result<String, String> {
    let n = id.and_then(Value::as_f64).filter(|n| n.fract() == 0.0).ok_or("Il faut le numéro du rappel.")?;
    if !store.cancel_reminder(n as i64) {
        return Err(format!("Aucun rappel n° {} en attente.", js_num(n)));
    }
    Ok(format!("Rappel n° {} annulé.", js_num(n)))
}

// ---- The tools ----

pub struct Tool {
    pub name: &'static str,
    pub description: String,
    pub input_schema: Value,
}

pub fn tools() -> Vec<Tool> {
    let t = |name, description: &str, input_schema| Tool { name, description: description.to_string(), input_schema };
    vec![
        t("heure", "Donne la date et l'heure exactes, ici ou dans un autre fuseau horaire.", json!({ "type": "object", "properties": { "fuseau": { "type": "string", "description": "Fuseau IANA, par exemple Asia/Tokyo pour l'heure à Tokyo. Sans fuseau : l'heure de cette machine." } } })),
        t("meteo", "Donne la météo actuelle et les prévisions sur 7 jours d'une ville. Si la ville n'est pas connue par la demande ou tes notes, demande-la : ne la devine jamais.", json!({ "type": "object", "properties": { "ville": { "type": "string", "description": "Nom de la ville, avec le pays si elle est ambiguë." } }, "required": ["ville"] })),
        t("actualites", "Donne les derniers titres de l'actualité générale, en France et dans le monde.", json!({ "type": "object", "properties": { "langue": { "type": "string", "enum": ["fr", "en"], "description": "Langue des titres. fr par défaut." } } })),
        t("calcul", "Calcule une expression exacte. Utilise-le pour tout calcul au lieu de le faire de tête. Opérations : + - * / ^ et parenthèses ; fonctions : sqrt, abs, round, floor, ceil, ln, log, sin, cos, tan ; constantes : pi, e. Un pourcentage s'écrit 150*20/100.", json!({ "type": "object", "properties": { "expression": { "type": "string", "description": "Par exemple (12+3)*1.2" } }, "required": ["expression"] })),
        t("convertir", &format!("Convertit une valeur d'une unité à une autre. Unités : {} (c, f et k sont les degrés ; j = jour, sem = semaine ; ko, mo, go, to = octets).", unit_names()), json!({ "type": "object", "properties": { "valeur": { "type": "number" }, "de": { "type": "string" }, "vers": { "type": "string" } }, "required": ["valeur", "de", "vers"] })),
        t("wikipedia", "Donne le résumé de l'article Wikipédia le plus proche d'un sujet : personnes, lieux, histoire, sciences, définitions.", json!({ "type": "object", "properties": { "sujet": { "type": "string" }, "langue": { "type": "string", "enum": ["fr", "en"], "description": "Langue de Wikipédia. fr par défaut." } }, "required": ["sujet"] })),
        t("rappel", "Programme un rappel ou un minuteur : Capri l'annoncera au moment voulu, si elle est ouverte, sinon à sa prochaine ouverture. Donne soit dans_minutes, soit a.", json!({ "type": "object", "properties": { "texte": { "type": "string", "description": "Ce qu'il faudra rappeler." }, "dans_minutes": { "type": "number", "description": "Dans combien de minutes." }, "a": { "type": "string", "description": "Date et heure locales, comme 2026-11-05T18:30." } }, "required": ["texte"] })),
        t("rappels", "Liste les rappels et minuteurs en attente, avec leur numéro.", json!({ "type": "object", "properties": {} })),
        t("annuler_rappel", "Annule un rappel ou un minuteur en attente, d'après son numéro donné par l'outil rappels.", json!({ "type": "object", "properties": { "numero": { "type": "number" } }, "required": ["numero"] })),
    ]
}

/// Runs one tool. Bad input comes back as an error text, never a crash.
pub async fn run(store: &Store, name: &str, args: &Map<String, Value>) -> Result<String, String> {
    let get = |k: &str| args.get(k);
    match name {
        "heure" => time_in(get("fuseau"), Utc::now()),
        "meteo" => weather(get("ville")).await,
        "actualites" => news(get("langue")).await,
        "calcul" => calculate(get("expression").unwrap_or(&Value::Null)).map(js_num),
        "convertir" => {
            let shown = |k: &str| match get(k) {
                Some(Value::String(s)) => s.clone(),
                Some(Value::Number(n)) => js_num(n.as_f64().unwrap_or(f64::NAN)),
                Some(Value::Null) | None => if get(k).is_some() { "null".into() } else { "undefined".into() },
                Some(other) => other.to_string(),
            };
            let result = convert(get("valeur").unwrap_or(&Value::Null), get("de").unwrap_or(&Value::Null), get("vers").unwrap_or(&Value::Null))?;
            Ok(format!("{} {} = {} {}", shown("valeur"), shown("de"), js_num(result), shown("vers")))
        }
        "wikipedia" => wikipedia(get("sujet"), get("langue")).await,
        "rappel" => add_reminder(store, args),
        "rappels" => Ok(list_reminders(store)),
        "annuler_rappel" => cancel_reminder(store, get("numero")),
        other => Err(format!("Outil inconnu : {other}.")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp_config::{safe_name, INFOS_SERVER};

    fn forecast() -> Value {
        json!({
            "current": { "time": "2026-11-05T15:45", "temperature_2m": 10.4, "apparent_temperature": 9, "relative_humidity_2m": 73, "precipitation": 0, "weather_code": 61, "wind_speed_10m": 2.5 },
            "daily": { "time": ["2026-11-05", "2026-11-06"], "weather_code": [61, 1234], "temperature_2m_max": [10.4, 12], "temperature_2m_min": [5.9, 8], "precipitation_probability_max": [60, null] },
        })
    }
    fn args(v: Value) -> Map<String, Value> {
        v.as_object().unwrap().clone()
    }

    #[test]
    fn time_is_shown_in_the_asked_zone_and_a_bad_zone_is_refused() {
        let at = Utc.with_ymd_and_hms(2026, 11, 5, 12, 0, 0).unwrap();
        let tokyo = time_in(Some(&json!("Asia/Tokyo")), at).unwrap();
        assert_eq!(tokyo, "jeudi 5 novembre 2026 à 21:00 UTC+09:00 (Asia/Tokyo)");
        assert_eq!(time_in(Some(&json!("Asia/Kolkata")), at).unwrap(), "jeudi 5 novembre 2026 à 17:30 UTC+05:30 (Asia/Kolkata)");
        assert_eq!(time_in(Some(&json!("America/St_Johns")), at).unwrap(), "jeudi 5 novembre 2026 à 08:30 UTC\u{2212}03:30 (America/St_Johns)");
        assert!(time_in(None, at).unwrap().contains("2026"));
        assert!(time_in(Some(&json!("Mars/Olympus")), at).unwrap_err().contains("Fuseau inconnu"));
        assert!(time_in(Some(&json!(3)), at).unwrap_err().contains("fuseau"));
    }

    #[test]
    fn a_place_needs_coordinates() {
        let found = json!({ "results": [{ "name": "Lyon", "admin1": "Auvergne-Rhône-Alpes", "country": "France", "latitude": 45.7, "longitude": 4.8 }] });
        assert_eq!(parse_place(&found), Some((45.7, 4.8, "Lyon, Auvergne-Rhône-Alpes, France".into())));
        for none in [json!({ "generationtime_ms": 1 }), Value::Null, json!({ "results": [{ "name": "Lyon" }] })] {
            assert_eq!(parse_place(&none), None);
        }
    }

    #[test]
    fn the_forecast_shows_what_came_back_and_refuses_a_partial_answer() {
        let shown = parse_forecast(&forecast()).unwrap();
        assert!(shown.contains("10.4 °C, ressenti 9 °C, pluie faible, humidité 73 %"), "{shown}");
        assert!(shown.contains("2026-11-05 : pluie faible, 5.9 à 10.4 °C, risque de précipitations 60 %."));
        assert!(shown.contains("2026-11-06 : code météo 1234, 8 à 12 °C.")); // no made-up sky, and no rain chance when there is none
        let mut cold = forecast();
        cold["current"]["temperature_2m"] = Value::Null;
        let mut short = forecast();
        short["daily"]["temperature_2m_max"] = json!([10]);
        for bad in [cold, short, json!({})] {
            assert!(parse_forecast(&bad).unwrap_err().contains("incomplète"));
        }
    }

    #[test]
    fn a_feed_is_read_whatever_its_escaping_and_an_empty_one_is_an_error() {
        let xml = r#"<rss><channel><title>Le flux</title><link>https://flux</link>
    <item><title><![CDATA[Été & <b>orage</b>]]></title><link>https://a.example/1?x=1&amp;y=2</link><description>L&#39;été &lt;p&gt;chaud&lt;/p&gt; &eacute;</description><pubDate>Thu, 05 Nov 2026 14:43:59 GMT</pubDate></item>
    <item><title>Sans lien</title></item>
    <item><title>Lien douteux</title><link>javascript:alert(1)</link></item>
    <item attr="1"><title>Sans date</title><link>http://a.example/2</link><pubDate>hier</pubDate></item>
    <item><title>Trop</title><link>http://a.example/3</link></item></channel></rss>"#;
        let item = |title: &str, link: &str, summary: &str, date: &str| Item { title: title.into(), link: link.into(), summary: summary.into(), date: date.into() };
        assert_eq!(parse_feed(xml, 2).unwrap(), vec![item("Été & orage", "https://a.example/1?x=1&y=2", "L'été chaud &eacute;", "2026-11-05T14:43:59.000Z"), item("Sans date", "http://a.example/2", "", "")]);
        assert!(parse_feed("<html>panne</html>", NEWS_ITEMS).unwrap_err().contains("aucun article"));
    }

    #[test]
    fn a_wikipedia_summary_needs_text_and_a_word_with_many_senses_asks_for_more() {
        let page = json!({ "title": "Lyon", "extract": " Lyon est une ville. ", "content_urls": { "desktop": { "page": "https://fr.wikipedia.org/wiki/Lyon" } } });
        assert_eq!(parse_summary(&page).unwrap(), "Lyon\nLyon est une ville.\nhttps://fr.wikipedia.org/wiki/Lyon\nSource : Wikipédia (CC BY-SA).");
        let mut unsafe_link = page.clone();
        unsafe_link["content_urls"]["desktop"]["page"] = json!("javascript:alert(1)");
        assert!(!parse_summary(&unsafe_link).unwrap().contains("javascript"));
        let mut many = page.clone();
        many["type"] = json!("disambiguation");
        assert!(parse_summary(&many).unwrap_err().contains("préciser"));
        assert!(parse_summary(&json!({ "title": "x" })).unwrap_err().contains("incomplète"));
    }

    #[test]
    fn a_reminders_time_must_be_one_future_moment_within_a_year() {
        let now = Utc.with_ymd_and_hms(2026, 11, 5, 12, 0, 0).unwrap().timestamp_millis() as f64;
        assert_eq!(reminder_time(Some(&json!(20)), None, now), Ok(now as i64 + 20 * 60_000));
        assert_eq!(reminder_time(None, Some(&json!("2026-11-05T13:00:00Z")), now), Ok(now as i64 + 3_600_000));
        let cases: [(Option<Value>, Option<Value>); 10] = [
            (None, None),
            (Some(json!(5)), Some(json!("2026-11-05T13:00:00Z"))),
            (Some(json!(0)), None),
            (Some(json!(-1)), None),
            (Some(json!("5")), None),
            (Some(json!(1e308)), None),
            (None, Some(json!("demain"))),
            (None, Some(json!("2026-13-45T13:00"))),
            (None, Some(json!("2020-01-01T00:00"))),
            (Some(json!(600_000)), None),
        ];
        for (minutes, date) in cases {
            assert!(reminder_time(minutes.as_ref(), date.as_ref(), now).is_err(), "{minutes:?} {date:?}");
        }
    }

    #[test]
    fn the_tool_names_match_what_the_settings_keep_allowed() {
        let allowed: Vec<String> = tools().iter().map(|t| format!("{}__{}", safe_name(INFOS_SERVER), t.name)).collect();
        let defaults = crate::store::defaults();
        let wanted: Vec<String> = defaults["mcpAllowed"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect();
        assert_eq!(allowed, wanted); // what stays allowed must match what is called
    }

    #[tokio::test]
    async fn bad_input_comes_back_as_an_error_before_any_network_call() {
        let store = Store::open(":memory:").unwrap();
        let long = "x".repeat(101);
        let cases = [("meteo", json!({})), ("meteo", json!({ "ville": long })), ("meteo", json!({ "ville": "a\nb" })), ("actualites", json!({ "langue": "constructor" })), ("heure", json!({ "fuseau": "Nulle/Part" })), ("absent", json!({}))];
        for (name, a) in cases {
            assert!(run(&store, name, &args(a.clone())).await.is_err(), "{name} {a}");
        }
        assert!(run(&store, "heure", &args(json!({ "fuseau": "Europe/Paris" }))).await.unwrap().contains("Europe/Paris"));
    }

    #[tokio::test]
    async fn reminders_are_set_listed_cancelled_and_handed_over_once() {
        let store = Store::open(":memory:").unwrap();
        let call = |name: &'static str, a: Value| {
            let store = &store;
            async move { run(store, name, &args(a)).await }
        };
        let first = call("rappel", json!({ "texte": "Sortir le gâteau", "dans_minutes": 20 })).await.unwrap();
        assert!(first.starts_with("Rappel n° 1 ") && first.ends_with("Sortir le gâteau"), "{first}");
        call("rappel", json!({ "texte": "Appeler", "dans_minutes": 40 })).await.unwrap();
        let list = call("rappels", json!({})).await.unwrap();
        assert!(Regex::new(r"n° 1.*\n.*n° 2").unwrap().is_match(&list), "{list}");
        assert!(call("annuler_rappel", json!({ "numero": 2 })).await.is_ok());
        assert!(call("annuler_rappel", json!({ "numero": 2 })).await.is_err());
        assert!(call("rappel", json!({ "texte": "a\nb", "dans_minutes": 1 })).await.is_err());
        let now = crate::store::now_ms();
        assert!(store.take_due_reminders(now).is_empty());
        assert_eq!(store.take_due_reminders(now + 21 * 60_000).iter().map(|r| r.text.clone()).collect::<Vec<_>>(), ["Sortir le gâteau"]);
        assert!(store.take_due_reminders(now + 21 * 60_000).is_empty());
        assert_eq!(call("calcul", json!({ "expression": "2+2" })).await.unwrap(), "4");
        assert_eq!(call("convertir", json!({ "valeur": 1, "de": "km", "vers": "m" })).await.unwrap(), "1 km = 1000 m");
    }
}

//! What the settings page may do to mcp.json: add and remove servers reached by URL. Never a command, which would run on this machine.
use crate::util::{js_trim, len16};
use serde_json::{json, Map, Value};

/// The server built into the app (infos.rs). It only reads or sets her own reminders, and it stays out of mcp.json.
pub const INFOS_SERVER: &str = "Capri Infos";
pub const INFOS_USE_CASE: &str = "Infos générales : date et heure, météo d'une ville, actualités, calculs et conversions, Wikipédia, rappels et minuteurs.";

const MAX_TOKEN: usize = 2000;
const MAX_NAME: usize = 40;
const MAX_USE_CASE: usize = 500;

/// Same as the page: every character outside [a-zA-Z0-9_-] becomes `_`, once per UTF-16 unit.
pub fn safe_name(text: &str) -> String {
    text.chars().map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c.to_string() } else { "_".repeat(c.len_utf16()) }).collect()
}

/// For the page: a URL can carry a token, in its query or before the host.
pub fn shown_url(url: &str) -> String {
    match url::Url::parse(url) {
        Ok(u) => format!("{}{}{}", u.origin().ascii_serialization(), u.path(), if u.query().is_some() { "?…" } else { "" }),
        Err(_) => "URL invalide".into(),
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct NewServer {
    pub name: String,
    pub url: String,
    pub use_case: String,
    pub headers: Option<Map<String, Value>>,
}

fn string(b: &Value, key: &str) -> String {
    b.get(key).and_then(Value::as_str).map(|s| js_trim(s).to_string()).unwrap_or_default()
}

pub fn parse_new_server(body: &Value) -> Result<NewServer, String> {
    let (name, url, use_case) = (string(body, "name"), string(body, "url"), string(body, "useCase"));
    if name.is_empty() || len16(&name) > MAX_NAME {
        return Err(format!("Donne-lui un nom de {MAX_NAME} caractères maximum."));
    }
    if use_case.is_empty() || len16(&use_case) > MAX_USE_CASE {
        return Err(format!("Décris son cas d'usage en {MAX_USE_CASE} caractères maximum."));
    }
    if !url::Url::parse(&url).is_ok_and(|u| matches!(u.scheme(), "http" | "https")) {
        return Err("L'URL doit commencer par http:// ou https://.".into());
    }
    let token = string(body, "token");
    if token.is_empty() {
        return Ok(NewServer { name, url, use_case, headers: None });
    }
    if len16(&token) > MAX_TOKEN || !token.bytes().all(|b| (0x21..=0x7e).contains(&b)) {
        return Err("Ce token n'est pas valide : pas d'espace ni de retour à la ligne.".into());
    }
    let mut headers = Map::new();
    match body.get("tokenKind").and_then(Value::as_str) {
        Some("bearer") => headers.insert("Authorization".into(), json!(format!("Bearer {token}"))),
        Some("x-api-key") => headers.insert("x-api-key".into(), json!(token)),
        _ => return Err("Choisis comment envoyer le token.".into()),
    };
    Ok(NewServer { name, url, use_case, headers: Some(headers) })
}

fn servers_of(config: &Value) -> Map<String, Value> {
    config.get("mcpServers").and_then(Value::as_object).cloned().unwrap_or_default()
}

fn with_servers(config: &Value, servers: Map<String, Value>) -> Value {
    let mut next = config.as_object().cloned().unwrap_or_default();
    next.insert("mcpServers".into(), Value::Object(servers));
    Value::Object(next)
}

pub fn with_server(config: &Value, server: &NewServer) -> Result<Value, String> {
    let mut servers = servers_of(config);
    // Compared on the name tools are built from, or "a b" and "a_b" would share their tools.
    let wanted = safe_name(&server.name).to_lowercase();
    if servers.keys().any(|n| safe_name(n).to_lowercase() == wanted) {
        return Err(format!("Le serveur « {} » existe déjà.", server.name));
    }
    let mut entry = json!({ "url": server.url, "useCase": server.use_case });
    if let Some(headers) = &server.headers {
        entry["headers"] = Value::Object(headers.clone());
    }
    servers.insert(server.name.clone(), entry);
    Ok(with_servers(config, servers))
}

pub fn without_server(config: &Value, name: &str) -> Result<Value, String> {
    let mut servers = servers_of(config);
    let Some(entry) = servers.get(name) else { return Err("Ce serveur n'existe plus.".into()) };
    if !entry.get("url").is_some_and(Value::is_string) {
        return Err("Ce serveur local se retire dans mcp.json.".into());
    }
    servers.shift_remove(name);
    Ok(with_servers(config, servers))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn good() -> Value {
        json!({ "name": "Boîte mail", "url": "https://mail.example/mcp", "useCase": "Lire les emails." })
    }
    fn plain() -> NewServer {
        NewServer { name: "Boîte mail".into(), url: "https://mail.example/mcp".into(), use_case: "Lire les emails.".into(), headers: None }
    }
    fn with(extra: Value) -> Value {
        let mut b = good();
        b.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
        b
    }

    #[test]
    fn a_new_server_needs_a_name_an_http_url_and_a_use_case() {
        assert_eq!(parse_new_server(&with(json!({ "name": " Boîte mail ", "command": "rm -rf /" }))), Ok(plain()));
        for bad in [Value::Null, json!({}), with(json!({ "name": " " })), with(json!({ "name": "x".repeat(41) })), with(json!({ "useCase": "" })), with(json!({ "useCase": "x".repeat(501) })), with(json!({ "url": "pas une url" })), with(json!({ "url": "file:///etc/passwd" })), with(json!({ "url": "javascript:alert(1)" })), with(json!({ "url": 3 }))] {
            assert!(parse_new_server(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn the_token_becomes_a_header_and_bad_ones_are_refused() {
        let headers = |v: Value| NewServer { headers: Some(v.as_object().unwrap().clone()), ..plain() };
        assert_eq!(parse_new_server(&with(json!({ "token": " abc ", "tokenKind": "bearer" }))), Ok(headers(json!({ "Authorization": "Bearer abc" }))));
        assert_eq!(parse_new_server(&with(json!({ "token": "abc", "tokenKind": "x-api-key" }))), Ok(headers(json!({ "x-api-key": "abc" }))));
        assert_eq!(parse_new_server(&with(json!({ "token": "  " }))), Ok(plain()));
        for bad in [json!({ "token": "a b", "tokenKind": "bearer" }), json!({ "token": "a\r\nX-Evil: 1", "tokenKind": "bearer" }), json!({ "token": "x".repeat(2001), "tokenKind": "bearer" }), json!({ "token": "abc" }), json!({ "token": "abc", "tokenKind": "cookie" })] {
            assert!(parse_new_server(&with(bad)).is_err());
        }
        let added = with_server(&json!({}), &headers(json!({ "x-api-key": "abc" }))).unwrap();
        assert_eq!(added["mcpServers"]["Boîte mail"], json!({ "url": "https://mail.example/mcp", "useCase": "Lire les emails.", "headers": { "x-api-key": "abc" } }));
    }

    #[test]
    fn a_token_in_a_url_is_never_shown() {
        assert_eq!(shown_url("https://a.example/mcp?token=secret"), "https://a.example/mcp?…");
        assert_eq!(shown_url("https://user:secret@a.example/mcp"), "https://a.example/mcp");
        assert_eq!(shown_url("https://a.example/mcp"), "https://a.example/mcp");
        assert_eq!(shown_url("pas une url"), "URL invalide");
    }

    #[test]
    fn adding_keeps_what_is_there_and_never_overwrites() {
        let local = json!({ "mcpServers": { "mes fichiers": { "command": "npx", "env": { "TOKEN": "t" } } }, "autre": 1 });
        let added = with_server(&local, &plain()).unwrap();
        assert_eq!(added, json!({ "autre": 1, "mcpServers": { "mes fichiers": { "command": "npx", "env": { "TOKEN": "t" } }, "Boîte mail": { "url": "https://mail.example/mcp", "useCase": "Lire les emails." } } }));
        assert!(with_server(&local, &NewServer { name: "mes_fichiers".into(), ..plain() }).is_err());
        assert_eq!(with_server(&json!({}), &plain()).unwrap(), json!({ "mcpServers": { "Boîte mail": { "url": "https://mail.example/mcp", "useCase": "Lire les emails." } } }));
        assert!(!added.to_string().contains("headers"));
    }

    #[test]
    fn removing_only_touches_url_servers() {
        let config = json!({ "mcpServers": { "web": { "url": "https://x" }, "local": { "command": "npx" } } });
        assert_eq!(without_server(&config, "web"), Ok(json!({ "mcpServers": { "local": { "command": "npx" } } })));
        for name in ["local", "absent", "constructor"] {
            assert!(without_server(&config, name).is_err(), "{name}");
        }
    }
}

//! Quotas as the providers report them: nothing here is estimated. No reading means no gauge.
use crate::util::{finite, js_trim, num_value};
use chrono::DateTime;
use regex::Regex;
use serde_json::{Map, Value};
use std::sync::OnceLock;

/// A gauge is a plain JSON object: absent fields are simply not there.
pub type Gauge = Map<String, Value>;

fn gauge(label: &str, fields: &[(&str, Option<f64>)], unit: Option<&str>) -> Gauge {
    let mut g = Map::new();
    g.insert("label".into(), label.into());
    for (name, value) in fields {
        if let Some(v) = value {
            g.insert((*name).into(), num_value(*v));
        }
    }
    if let Some(u) = unit {
        g.insert("unit".into(), u.into());
    }
    g
}

fn count(value: Option<String>) -> Option<f64> {
    let text = value?;
    let text = js_trim(&text);
    if text.is_empty() {
        return None;
    }
    text.parse::<f64>().ok().filter(|n| n.is_finite())
}

fn unit_ms(unit: &str) -> f64 {
    match unit {
        "ms" => 1.0,
        "s" => 1000.0,
        "m" => 60_000.0,
        "h" => 3_600_000.0,
        _ => 86_400_000.0,
    }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).unwrap())
}

/// Providers disagree: "6m0s" (OpenAI), RFC 3339 (Anthropic), seconds, or epoch seconds or milliseconds.
pub fn reset_time(value: Option<&str>, now: f64) -> Option<f64> {
    static NUMBER: OnceLock<Regex> = OnceLock::new();
    static SPAN: OnceLock<Regex> = OnceLock::new();
    static PART: OnceLock<Regex> = OnceLock::new();
    let text = js_trim(value?);
    if text.is_empty() {
        return None;
    }
    if re(&NUMBER, r"^\d+(\.\d+)?$").is_match(text) {
        let n: f64 = text.parse().ok()?;
        return Some(if n > 1e11 { n } else if n > 1e9 { n * 1000.0 } else { now + n * 1000.0 });
    }
    if re(&SPAN, r"^(\d+(\.\d+)?(ms|s|m|h|d))+$").is_match(text) {
        let span: f64 = re(&PART, r"(\d+(?:\.\d+)?)(ms|s|m|h|d)").captures_iter(text).map(|c| c[1].parse::<f64>().unwrap() * unit_ms(&c[2])).sum();
        return Some(now + span);
    }
    DateTime::parse_from_rfc3339(text).ok().map(|d| d.timestamp_millis() as f64)
}

/// The limits a provider states in its x-ratelimit-* response headers, when it does.
pub fn quota_from_headers(header: &dyn Fn(&str) -> Option<String>, now: f64) -> Vec<Gauge> {
    let mut gauges = Vec::new();
    for (label, kind) in [("Requêtes", "requests"), ("Tokens", "tokens")] {
        let remaining = count(header(&format!("x-ratelimit-remaining-{kind}")).or_else(|| header(&format!("anthropic-ratelimit-{kind}-remaining"))));
        let Some(remaining) = remaining else { continue };
        // Anthropic's OpenAI layer sends the limit as x-ratelimit-requests, not x-ratelimit-limit-requests.
        let limit = count(header(&format!("x-ratelimit-limit-{kind}")).or_else(|| header(&format!("x-ratelimit-{kind}"))).or_else(|| header(&format!("anthropic-ratelimit-{kind}-limit"))));
        let reset = header(&format!("x-ratelimit-reset-{kind}")).or_else(|| header(&format!("anthropic-ratelimit-{kind}-reset")));
        gauges.push(gauge(label, &[("remaining", Some(remaining)), ("limit", limit), ("resetAt", reset_time(reset.as_deref(), now))], None));
    }
    if gauges.is_empty() {
        if let Some(remaining) = count(header("x-ratelimit-remaining")) {
            gauges.push(gauge("Requêtes", &[("remaining", Some(remaining)), ("limit", count(header("x-ratelimit-limit"))), ("resetAt", reset_time(header("x-ratelimit-reset").as_deref(), now))], None));
        }
    }
    gauges
}

/// GET openrouter.ai/api/v1/key. limit and limit_remaining are null on a key with no spending limit.
pub fn open_router_gauges(body: &Value) -> Vec<Gauge> {
    let d = &body["data"];
    let mut gauges = Vec::new();
    let (limit, remaining, used) = (finite(d.get("limit")), finite(d.get("limit_remaining")), finite(d.get("usage")));
    if let (Some(limit), Some(remaining)) = (limit, remaining) {
        gauges.push(gauge("Crédits de la clé", &[("remaining", Some(remaining)), ("limit", Some(limit))], Some("$")));
    } else if let Some(used) = used {
        gauges.push(gauge("Crédits utilisés (clé sans plafond)", &[("used", Some(used))], Some("$")));
    }
    let free = &d["free_model_daily_requests"];
    if let Some(left) = finite(free.get("remaining")) {
        gauges.push(gauge("Modèles gratuits, par jour", &[("remaining", Some(left)), ("limit", finite(free.get("limit")))], None));
    }
    gauges
}

/// GET api.elevenlabs.io/v1/user/subscription.
pub fn eleven_labs_gauges(body: &Value) -> Vec<Gauge> {
    let (Some(used), Some(limit)) = (finite(body.get("character_count")), finite(body.get("character_limit"))) else { return vec![] };
    let reset = finite(body.get("next_character_count_reset_unix")).map(|r| r * 1000.0);
    vec![gauge("Caractères", &[("remaining", Some((limit - used).max(0.0))), ("limit", Some(limit)), ("resetAt", reset)], None)]
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::collections::HashMap;

    const NOW: f64 = 1_800_000_000_000.0;

    fn headers(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        move |k| map.get(k).cloned()
    }
    fn as_json(g: Vec<Gauge>) -> Value {
        Value::Array(g.into_iter().map(Value::Object).collect())
    }

    #[test]
    fn reset_times_in_every_format_providers_use() {
        let at = |s: &str| reset_time(Some(s), NOW);
        assert_eq!(at("6m0s"), Some(NOW + 360_000.0));
        assert_eq!(at("1h2m3.5s"), Some(NOW + 3_723_500.0));
        assert_eq!(at("120ms"), Some(NOW + 120.0));
        assert_eq!(at("30"), Some(NOW + 30_000.0));
        assert_eq!(at("1800000100"), Some(1_800_000_100_000.0));
        assert_eq!(at("1800000100000"), Some(1_800_000_100_000.0));
        assert_eq!(at("2027-01-27T12:00:00Z"), Some(1_801_051_200_000.0));
        assert_eq!(at("nonsense"), None);
        assert_eq!(reset_time(None, NOW), None);
    }

    #[test]
    fn openai_headers() {
        let h = headers(&[("x-ratelimit-limit-requests", "500"), ("x-ratelimit-remaining-requests", "499"), ("x-ratelimit-reset-requests", "1s"), ("x-ratelimit-limit-tokens", "30000"), ("x-ratelimit-remaining-tokens", "29000"), ("x-ratelimit-reset-tokens", "2s")]);
        assert_eq!(
            as_json(quota_from_headers(&h, NOW)),
            json!([{ "label": "Requêtes", "remaining": 499, "limit": 500, "resetAt": 1_800_000_001_000_i64 }, { "label": "Tokens", "remaining": 29000, "limit": 30000, "resetAt": 1_800_000_002_000_i64 }])
        );
    }

    #[test]
    fn anthropic_headers_native_and_through_its_openai_layer() {
        let native = headers(&[("anthropic-ratelimit-requests-limit", "50"), ("anthropic-ratelimit-requests-remaining", "49"), ("anthropic-ratelimit-requests-reset", "2027-01-27T12:00:00Z")]);
        assert_eq!(as_json(quota_from_headers(&native, NOW)), json!([{ "label": "Requêtes", "remaining": 49, "limit": 50, "resetAt": 1_801_051_200_000_i64 }]));
        let layer = headers(&[("x-ratelimit-requests", "50"), ("x-ratelimit-remaining-requests", "49")]);
        assert_eq!(quota_from_headers(&layer, NOW)[0]["limit"], 50);
    }

    #[test]
    fn a_provider_that_sends_nothing_gets_no_gauge_never_a_zero() {
        assert!(quota_from_headers(&headers(&[("content-type", "application/json")]), NOW).is_empty());
        assert!(quota_from_headers(&headers(&[("x-ratelimit-remaining-requests", "many")]), NOW).is_empty());
    }

    #[test]
    fn openrouter_with_and_without_a_spending_limit() {
        assert_eq!(as_json(open_router_gauges(&json!({ "data": { "limit": 10, "limit_remaining": 7.5, "usage": 2.5 } }))), json!([{ "label": "Crédits de la clé", "remaining": 7.5, "limit": 10, "unit": "$" }]));
        assert_eq!(as_json(open_router_gauges(&json!({ "data": { "limit": null, "limit_remaining": null, "usage": 2.5 } }))), json!([{ "label": "Crédits utilisés (clé sans plafond)", "used": 2.5, "unit": "$" }]));
        assert_eq!(open_router_gauges(&json!({ "data": { "limit": null, "usage": 0, "free_model_daily_requests": { "used": 1, "limit": 50, "remaining": 49 } } }))[1]["remaining"], 49);
        assert!(open_router_gauges(&Value::Null).is_empty());
    }

    #[test]
    fn elevenlabs() {
        assert_eq!(as_json(eleven_labs_gauges(&json!({ "character_count": 1000, "character_limit": 10000, "next_character_count_reset_unix": 1_800_000_100_i64 }))), json!([{ "label": "Caractères", "remaining": 9000, "limit": 10000, "resetAt": 1_800_000_100_000_i64 }]));
        assert!(eleven_labs_gauges(&json!({ "detail": "missing" })).is_empty());
    }
}

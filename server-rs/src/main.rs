//! Capri's server: the same routes the Next app had under /api, plus the exported page. Local requests only.
mod calc;
mod guard;
mod infos;
mod mcp;
mod mcp_config;
mod messages;
mod persona;
mod quota;
mod store;
mod util;

use axum::body::{Body, Bytes};
use axum::extract::{Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;
use store::{Row, Store};
use tower_http::services::ServeDir;
use util::{len16, slice16};

const STORE_BODY: usize = 12_000_000; // more than a browser's localStorage can hold
const CHAT_BODY: usize = 2_000_000;
const HIDDEN_WAIT: i64 = 30_000;
const MAX_VOICE_TEXT: usize = 4000;

struct App {
    store: Arc<Store>,
    mcp: mcp::Mcp,
    data_dir: PathBuf,
}
type Shared = State<Arc<App>>;

fn reply(status: u16, body: Value) -> Response {
    (StatusCode::from_u16(status).unwrap(), [("content-type", "application/json")], body.to_string()).into_response()
}
fn ok(body: Value) -> Response {
    reply(200, body)
}
fn refused() -> Response {
    reply(403, json!({ "error": "local_only" }))
}
fn bad_request() -> Response {
    reply(400, json!({ "error": "bad_request" }))
}
fn provider_failed() -> Response {
    reply(502, json!({ "error": "provider_failed" }))
}

fn client() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().build().expect("http client"))
}

fn parse(body: &Bytes) -> Option<Value> {
    serde_json::from_slice(body).ok()
}

/// Same as the page's settingsFrom: every built-in tool is allowed once, when first seen, so taking one off sticks.
fn settings_from(saved: &Row) -> Row {
    let defaults = store::defaults();
    let all: Vec<Value> = defaults.get("mcpAllowed").and_then(Value::as_array).cloned().unwrap_or_default();
    let seen: Vec<Value> = match saved.get("infosAllowed") {
        Some(Value::Bool(true)) => all.iter().take(3).cloned().collect(),
        Some(Value::Array(a)) => a.clone(),
        _ => vec![],
    };
    let mut allowed: Vec<Value> = all.iter().filter(|t| !seen.contains(t)).cloned().collect();
    allowed.extend(saved.get("mcpAllowed").and_then(Value::as_array).cloned().unwrap_or_default());
    let mut next = defaults;
    next.extend(saved.clone());
    next.insert("mcpAllowed".into(), Value::Array(allowed));
    next.insert("infosAllowed".into(), Value::Array(all));
    next
}

// ---- /api/store ----

fn store_body(body: &Bytes) -> Option<Map<String, Value>> {
    let raw = std::str::from_utf8(body).ok()?;
    if len16(raw) > STORE_BODY {
        return None;
    }
    match serde_json::from_str::<Value>(raw).ok()? {
        Value::Object(o) => Some(o),
        _ => None,
    }
}

async fn store_get(State(app): Shared, headers: HeaderMap) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    ok(app.store.read())
}

async fn store_put(State(app): Shared, headers: HeaderMap, body: Bytes) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let Some(b) = store_body(&body) else { return bad_request() };
    let secrets = b.get("secrets").and_then(Value::as_object).filter(|s| s.values().all(|v| v.as_str().is_some_and(|v| len16(v) <= 1000)));
    let wrong_settings = b.get("settings").is_some_and(|s| !s.is_object());
    let wrong_secrets = b.get("secrets").is_some() && secrets.is_none();
    let wrong_append = b.get("append").is_some_and(|a| !a.is_array());
    if wrong_settings || wrong_secrets || wrong_append {
        return bad_request();
    }
    let saved = (|| {
        if let Some(s) = b.get("settings").and_then(Value::as_object) {
            app.store.save_settings(s)?;
        }
        if let Some(s) = secrets {
            app.store.save_secrets(s)?;
        }
        if let Some(a) = b.get("append").and_then(Value::as_array) {
            app.store.append(a)?;
        }
        if b.get("clearHistory") == Some(&Value::Bool(true)) {
            app.store.clear_history()?;
        }
        Ok::<(), rusqlite::Error>(())
    })();
    match saved {
        Ok(()) => ok(json!({ "ok": true })),
        Err(e) => {
            eprintln!("[store] {e}");
            reply(500, json!({ "error": "internal" }))
        }
    }
}

/// One browser's localStorage, as it was. Copied to a file first: the page only deletes its own once this answers ok.
async fn store_migrate(State(app): Shared, headers: HeaderMap, body: Bytes) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let Some(b) = store_body(&body) else { return bad_request() };
    let field = |k: &str| b.get(k).cloned().unwrap_or(Value::Null);
    let copy = json!({ "settings": field("settings"), "history": field("history") }).to_string();
    let name = format!("localStorage-{}.json", &Sha256::digest(copy.as_bytes()).iter().map(|x| format!("{x:02x}")).collect::<String>()[..12]);
    let written = (|| {
        std::fs::create_dir_all(&app.data_dir)?;
        write_private(&app.data_dir.join(name), &copy)
    })();
    if let Err(e) = written {
        eprintln!("[store] {e}");
        return reply(500, json!({ "error": "internal" }));
    }
    let parsed = |v: Value| v.as_str().and_then(|s| serde_json::from_str::<Value>(s).ok());
    let settings = match parsed(field("settings")) {
        Some(Value::Object(o)) => settings_from(&o),
        _ => Row::new(),
    };
    let history = match parsed(field("history")) {
        Some(Value::Array(a)) => a,
        _ => vec![],
    };
    match app.store.migrate(&settings, &history) {
        Ok(()) => ok(json!({ "ok": true })),
        Err(e) => {
            eprintln!("[store] {e}");
            reply(500, json!({ "error": "internal" }))
        }
    }
}

fn write_private(path: &std::path::Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)?.write_all(text.as_bytes())
}

// ---- /api/chat ----

async fn provider_text(res: reqwest::Response) -> String {
    slice16(&res.text().await.unwrap_or_default(), 300)
}

/// One step of the conversation: sends the messages to the provider and returns her reply or the tools she wants to run.
async fn chat(State(app): Shared, headers: HeaderMap, body: Bytes) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let raw = String::from_utf8_lossy(&body);
    if len16(&raw) > CHAT_BODY {
        return reply(413, json!({ "error": "too_large" }));
    }
    let parsed: Value = serde_json::from_str(&raw).unwrap_or(Value::Null);
    let brain = app.store.saved_brain();
    let (Some(messages), Some(brain)) = (messages::parse_messages(&parsed), brain) else { return bad_request() };
    if brain.model.is_empty() {
        return reply(503, json!({ "error": "not_configured" }));
    }
    let character = messages::parse_character(parsed.get("character"));
    let tools = if parsed.get("useTools") == Some(&Value::Bool(true)) { app.mcp.chat_tools().await } else { vec![] };

    let send = |with_tools: bool| {
        let mut all = vec![json!({ "role": "system", "content": persona::build_prompt(&character, with_tools, chrono::Local::now()) })];
        all.extend(persona::with_language_rule(&messages, &character.language));
        let mut payload = json!({ "model": brain.model, "messages": all, "max_tokens": persona::reply_limit(character.replies, character.max_reply, with_tools) });
        if with_tools {
            payload["tools"] = Value::Array(tools.clone());
        }
        let mut request = client().post(format!("{}/chat/completions", brain.url)).timeout(Duration::from_secs(120)).header("Content-Type", "application/json");
        if !brain.key.is_empty() {
            request = request.header("Authorization", format!("Bearer {}", brain.key));
        }
        request.body(payload.to_string()).send()
    };

    let now = store::now_ms() as f64;
    let result: Result<Response, String> = async {
        let mut res = send(!tools.is_empty()).await.map_err(|e| e.to_string())?;
        // Some models can't take tools at all; talking still has to work. Not mid-job, where tool messages need them.
        if res.status().as_u16() == 400 && !tools.is_empty() && !messages.iter().any(|m| m["role"] == "tool") {
            res = send(false).await.map_err(|e| e.to_string())?;
        }
        let header = |name: &str| res.headers().get(name).and_then(|v| v.to_str().ok()).map(String::from);
        let gauges = quota::quota_from_headers(&header, now);
        let gauges = Value::Array(gauges.into_iter().map(Value::Object).collect());
        if !res.status().is_success() {
            let (status, retry) = (res.status().as_u16(), quota::reset_time(header("retry-after").as_deref(), now));
            eprintln!("[chat] provider answered {status} {}", provider_text(res).await);
            let mut out = json!({ "error": "provider_failed", "status": status, "quota": gauges });
            if let Some(at) = retry {
                out["retryAt"] = util::num_value(at);
            }
            return Ok(reply(502, out));
        }
        let answer: Value = res.json().await.map_err(|e| e.to_string())?;
        let message = answer.pointer("/choices/0/message");
        let text = message.and_then(|m| m.get("content")).and_then(Value::as_str).map(|c| util::js_trim(c).to_string()).unwrap_or_default();
        let calls = message.and_then(|m| m.get("tool_calls")).and_then(Value::as_array).filter(|c| !c.is_empty()).cloned();
        if text.is_empty() && calls.is_none() {
            return Err("provider sent nothing".into());
        }
        let mut out = Map::new();
        out.insert("reply".into(), json!(text));
        if let Some(c) = calls {
            out.insert("toolCalls".into(), Value::Array(c));
        }
        out.insert("quota".into(), gauges);
        if let Some(t) = answer.pointer("/usage/total_tokens") {
            out.insert("tokens".into(), t.clone());
        }
        Ok(ok(Value::Object(out)))
    }
    .await;
    result.unwrap_or_else(|e| {
        eprintln!("[chat] {e}");
        provider_failed()
    })
}

// ---- /api/mcp ----

async fn mcp_changed(app: &App, change: Result<Option<String>, String>) -> Response {
    match change {
        Ok(Some(problem)) => reply(400, json!({ "problem": problem })),
        Ok(None) => ok(app.mcp.status(false).await),
        Err(e) => {
            eprintln!("[mcp] mcp.json {e}");
            reply(500, json!({ "problem": "Impossible de modifier mcp.json. Vérifie que ce fichier est valide." }))
        }
    }
}

async fn mcp_add(State(app): Shared, headers: HeaderMap, body: Bytes) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    match mcp_config::parse_new_server(&parse(&body).unwrap_or(Value::Null)) {
        Err(problem) => reply(400, json!({ "problem": problem })),
        Ok(server) => mcp_changed(&app, app.mcp.add_server(&server).await).await,
    }
}

async fn mcp_remove(State(app): Shared, headers: HeaderMap, body: Bytes) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let name = parse(&body).and_then(|b| b.get("name").and_then(Value::as_str).map(String::from));
    match name {
        None => reply(400, json!({ "problem": "Quel serveur ?" })),
        Some(name) => mcp_changed(&app, app.mcp.remove_server(&name).await).await,
    }
}

async fn mcp_list(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    ok(app.mcp.status(query.contains_key("reload")).await)
}

/// Runs one tool the model asked for, once the page has allowed it.
async fn mcp_call(State(app): Shared, headers: HeaderMap, body: Bytes) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let b = parse(&body).unwrap_or(Value::Null);
    let (Some(name), Some(args)) = (b.get("name").and_then(Value::as_str), b.get("arguments").and_then(Value::as_object)) else { return bad_request() };
    match app.mcp.call_tool(name, args).await {
        Ok(Some(result)) => ok(result),
        Ok(None) => reply(404, json!({ "error": "unknown_tool" })),
        Err(e) => {
            eprintln!("[mcp] {name} {e}");
            ok(json!({ "text": format!("L'outil a échoué : {e}"), "isError": true }))
        }
    }
}

// ---- /api/models, /api/quota ----

async fn models(State(app): Shared, headers: HeaderMap) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let Some(brain) = app.store.saved_brain() else { return bad_request_with("bad_address") };
    let mut request = client().get(format!("{}/models", brain.url)).timeout(Duration::from_secs(15));
    if !brain.key.is_empty() {
        request = request.header("Authorization", format!("Bearer {}", brain.key));
    }
    let listed: Result<Response, String> = async {
        let res = request.send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Ok(reply(502, json!({ "error": "provider_failed", "status": res.status().as_u16() })));
        }
        let body: Value = res.json().await.map_err(|e| e.to_string())?;
        let list = body.get("data").and_then(Value::as_array).ok_or("no model list")?;
        let mut ids: Vec<&str> = list.iter().filter_map(|m| m.get("id").and_then(Value::as_str)).collect();
        ids.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16())); // same order as JS's default sort
        Ok(ok(json!({ "models": ids })))
    }
    .await;
    listed.unwrap_or_else(|e| {
        eprintln!("[models] {e}");
        provider_failed()
    })
}

fn bad_request_with(error: &str) -> Response {
    reply(400, json!({ "error": error }))
}

/// A quota with its own endpoint: { gauges } or { error: status }, never a made-up number.
async fn reading(url: &str, header: (&str, String), gauges: fn(&Value) -> Vec<quota::Gauge>) -> Value {
    let got = async {
        let res = client().get(url).header(header.0, header.1).timeout(Duration::from_secs(10)).send().await.map_err(|e| e.to_string())?;
        if !res.status().is_success() {
            return Ok(json!({ "error": res.status().as_u16() }));
        }
        let body: Value = res.json().await.map_err(|e| e.to_string())?;
        Ok::<Value, String>(json!({ "gauges": gauges(&body).into_iter().map(Value::Object).collect::<Vec<_>>() }))
    }
    .await;
    got.unwrap_or_else(|e| {
        eprintln!("[quota] {e}");
        json!({ "error": 0 })
    })
}

fn is_open_router(url: &str) -> bool {
    url::Url::parse(url).is_ok_and(|u| u.host_str() == Some("openrouter.ai")) // this key is only ever sent to its own provider
}

/// The two providers with a free endpoint to read. Everyone else reports through the headers of a chat reply.
async fn quotas(State(app): Shared, headers: HeaderMap) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let brain = app.store.saved_brain();
    let eleven = if app.store.settings().get("voiceMode").and_then(Value::as_str) == Some("cloud") { app.store.secret("elevenKey") } else { String::new() };
    let credits = async {
        match brain.filter(|b| !b.key.is_empty() && is_open_router(&b.url)) {
            Some(b) => Some(reading("https://openrouter.ai/api/v1/key", ("Authorization", format!("Bearer {}", b.key)), |v| quota::open_router_gauges(v)).await),
            None => None,
        }
    };
    let voice = async {
        match eleven.is_empty() {
            true => None,
            false => Some(reading("https://api.elevenlabs.io/v1/user/subscription", ("xi-api-key", eleven.clone()), |v| quota::eleven_labs_gauges(v)).await),
        }
    };
    let (credits, voice) = tokio::join!(credits, voice);
    let mut out = Map::new();
    if let Some(c) = credits {
        out.insert("credits".into(), c);
    }
    if let Some(v) = voice {
        out.insert("voice".into(), v);
    }
    ok(Value::Object(out))
}

// ---- /api/reminders, /api/voice ----

/// The page asks what's due, and each reminder is handed over once. A tab in front gets it first; a hidden one only if none took it.
async fn reminders(State(app): Shared, headers: HeaderMap, Query(query): Query<HashMap<String, String>>) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let wait = if query.contains_key("hidden") { HIDDEN_WAIT } else { 0 };
    let due: Vec<Value> = app.store.take_due_reminders(store::now_ms() - wait).iter().map(|r| json!({ "id": r.id, "text": r.text, "at": r.at })).collect();
    ok(json!({ "due": due }))
}

fn word_ok(text: &str, most: usize, dot: bool) -> bool {
    (1..=most).contains(&text.len()) && text.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || (dot && b == b'.'))
}

/// Proxy for her ElevenLabs voice, with the key saved on this machine.
async fn voice(State(app): Shared, headers: HeaderMap, body: Bytes) -> Response {
    if !guard::is_local_request(&headers) {
        return refused();
    }
    let b = parse(&body).unwrap_or(Value::Null);
    let key = app.store.secret("elevenKey");
    let (id, model, text) = (b.get("voiceId").and_then(Value::as_str), b.get("model").and_then(Value::as_str), b.get("text").and_then(Value::as_str));
    let (Some(id), Some(model), Some(text)) = (id, model, text) else { return bad_request() };
    if key.is_empty() || !word_ok(id, 64, false) || !word_ok(model, 64, true) || util::js_trim(text).is_empty() || len16(text) > MAX_VOICE_TEXT {
        return bad_request();
    }
    let sent = client()
        .post(format!("https://api.elevenlabs.io/v1/text-to-speech/{id}?output_format=wav_24000"))
        .timeout(Duration::from_secs(30))
        .header("Content-Type", "application/json")
        .header("xi-api-key", key)
        .body(json!({ "text": text, "model_id": model }).to_string())
        .send()
        .await;
    match sent {
        Ok(res) if res.status().is_success() => (StatusCode::OK, [("content-type", "audio/wav")], Body::from_stream(res.bytes_stream())).into_response(),
        Ok(res) => {
            let status = res.status().as_u16();
            eprintln!("[voice] ElevenLabs answered {status} {}", provider_text(res).await);
            reply(502, json!({ "error": "provider_failed", "status": status }))
        }
        Err(e) => {
            eprintln!("[voice] {e}");
            provider_failed()
        }
    }
}

// ---- Start ----

fn router(app: Arc<App>, pages: PathBuf) -> Router {
    Router::new()
        .route("/api/store", get(store_get).put(store_put).post(store_migrate))
        .route("/api/chat", post(chat))
        .route("/api/mcp", get(mcp_list).put(mcp_add).delete(mcp_remove).post(mcp_call))
        .route("/api/models", post(models))
        .route("/api/quota", post(quotas))
        .route("/api/reminders", post(reminders))
        .route("/api/voice", post(voice))
        .fallback_service(ServeDir::new(pages).append_index_html_on_directories(true))
        .layer(axum::extract::DefaultBodyLimit::max(64_000_000)) // the routes check their own limits
        .with_state(app)
}

fn env_or(name: &str, fallback: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

#[tokio::main]
async fn main() {
    let data_dir = PathBuf::from(env_or("CAPRI_DATA_DIR", "data"));
    let store = Arc::new(Store::open(data_dir.join("capri.db").to_str().expect("data dir")).expect("data/capri.db"));
    let mcp = mcp::Mcp::new(PathBuf::from(env_or("CAPRI_MCP_CONFIG", "mcp.json")), store.clone());
    let app = router(Arc::new(App { store, mcp, data_dir }), PathBuf::from(env_or("CAPRI_STATIC_DIR", "out")));
    let address = format!("{}:{}", env_or("HOSTNAME", "127.0.0.1"), env_or("PORT", "3000"));
    let listener = tokio::net::TcpListener::bind(&address).await.unwrap_or_else(|e| panic!("{address} : {e}"));
    println!("Capri écoute sur http://{address}");
    axum::serve(listener, app).await.expect("server");
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::body::to_bytes;
    use axum::http::Request;
    use tower::ServiceExt;

    fn app(dir: &std::path::Path) -> Router {
        let store = Arc::new(Store::open(dir.join("capri.db").to_str().unwrap()).unwrap());
        let mcp = mcp::Mcp::new(dir.join("mcp.json"), store.clone());
        std::fs::create_dir_all(dir.join("out")).unwrap();
        std::fs::write(dir.join("out/index.html"), "<h1>Capri</h1>").unwrap();
        router(Arc::new(App { store, mcp, data_dir: dir.to_path_buf() }), dir.join("out"))
    }

    async fn call(router: &Router, method: &str, uri: &str, body: &str, host: &str) -> (u16, Value) {
        let request = Request::builder().method(method).uri(uri).header("host", host).header("content-type", "application/json").body(Body::from(body.to_string())).unwrap();
        let res = router.clone().oneshot(request).await.unwrap();
        let status = res.status().as_u16();
        let bytes = to_bytes(res.into_body(), usize::MAX).await.unwrap();
        (status, serde_json::from_slice(&bytes).unwrap_or_else(|_| json!(String::from_utf8_lossy(&bytes))))
    }

    #[tokio::test]
    async fn settings_keys_and_history_go_through_the_store_and_keys_never_come_back() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let local = "localhost:3000";
        assert_eq!(call(&app, "PUT", "/api/store", r#"{"settings":{"model":"m"},"secrets":{"apiKey":"sk-1"},"append":[{"role":"user","content":"salut"}]}"#, local).await.0, 200);
        let (status, read) = call(&app, "GET", "/api/store", "", local).await;
        assert_eq!(status, 200);
        assert_eq!(read["settings"]["model"], "m");
        assert_eq!(read["settings"]["apiKeySet"], true);
        assert!(!read.to_string().contains("sk-1"));
        assert_eq!(read["history"], json!([{ "role": "user", "content": "salut" }]));
        for bad in [r#"[]"#, r#"{"settings":null}"#, r#"{"secrets":{"apiKey":3}}"#, r#"{"append":{}}"#, "pas du json"] {
            assert_eq!(call(&app, "PUT", "/api/store", bad, local).await, (400, json!({ "error": "bad_request" })), "{bad}");
        }
        assert_eq!(call(&app, "PUT", "/api/store", r#"{"clearHistory":true}"#, local).await.0, 200);
        assert_eq!(call(&app, "GET", "/api/store", "", local).await.1["history"], json!([]));
    }

    #[tokio::test]
    async fn every_route_refuses_what_is_not_this_machine() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        for (method, uri) in [("GET", "/api/store"), ("PUT", "/api/store"), ("POST", "/api/store"), ("POST", "/api/chat"), ("GET", "/api/mcp"), ("PUT", "/api/mcp"), ("DELETE", "/api/mcp"), ("POST", "/api/mcp"), ("POST", "/api/models"), ("POST", "/api/quota"), ("POST", "/api/reminders"), ("POST", "/api/voice")] {
            assert_eq!(call(&app, method, uri, "{}", "capri.example.com").await, (403, json!({ "error": "local_only" })), "{method} {uri}");
        }
    }

    #[tokio::test]
    async fn the_migration_keeps_a_copy_and_fills_in_the_settings() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let local = "localhost:3000";
        let old = json!({ "settings": json!({ "model": "old-model", "infosAllowed": true, "mcpAllowed": ["x__y"] }).to_string(), "history": json!([{ "role": "user", "content": "avant" }]).to_string() });
        assert_eq!(call(&app, "POST", "/api/store", &old.to_string(), local).await, (200, json!({ "ok": true })));
        let copies = std::fs::read_dir(dir.path()).unwrap().filter_map(Result::ok).filter(|e| e.file_name().to_string_lossy().starts_with("localStorage-")).count();
        assert_eq!(copies, 1);
        let read = call(&app, "GET", "/api/store", "", local).await.1;
        assert_eq!(read["settings"]["model"], "old-model");
        assert_eq!(read["history"][0]["content"], "avant");
        // infosAllowed was `true` (only the first three tools were known): the later ones are allowed once, the rest keeps what she chose.
        let allowed: Vec<&str> = read["settings"]["mcpAllowed"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
        assert!(allowed.contains(&"Capri_Infos__rappel") && allowed.contains(&"x__y") && !allowed.contains(&"Capri_Infos__heure"), "{allowed:?}");
    }

    #[tokio::test]
    async fn chat_and_tools_refuse_bad_input_and_the_built_in_tools_run() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        let local = "localhost:3000";
        assert_eq!(call(&app, "POST", "/api/chat", "{}", local).await, (400, json!({ "error": "bad_request" })));
        assert_eq!(call(&app, "POST", "/api/chat", &"x".repeat(2_000_001), local).await, (413, json!({ "error": "too_large" })));
        assert_eq!(call(&app, "POST", "/api/mcp", r#"{"name":"a"}"#, local).await.0, 400);
        assert_eq!(call(&app, "POST", "/api/mcp", r#"{"name":"nobody__x","arguments":{}}"#, local).await, (404, json!({ "error": "unknown_tool" })));
        assert_eq!(call(&app, "POST", "/api/mcp", r#"{"name":"Capri_Infos__calcul","arguments":{"expression":"6*7"}}"#, local).await, (200, json!({ "text": "42", "isError": false })));
        assert_eq!(call(&app, "DELETE", "/api/mcp", "{}", local).await, (400, json!({ "problem": "Quel serveur ?" })));
        assert_eq!(call(&app, "PUT", "/api/mcp", r#"{"name":"x"}"#, local).await.0, 400);
        let (status, listed) = call(&app, "GET", "/api/mcp", "", local).await;
        assert_eq!((status, listed["servers"][0]["name"].clone()), (200, json!("Capri Infos")));
        assert_eq!(call(&app, "POST", "/api/reminders", "", local).await, (200, json!({ "due": [] })));
        assert_eq!(call(&app, "POST", "/api/models", "", local).await.0, 502); // the default provider is unreachable without a key in tests
        assert_eq!(call(&app, "POST", "/api/voice", "{}", local).await.0, 400);
    }

    #[tokio::test]
    async fn the_exported_page_is_served() {
        let dir = tempfile::tempdir().unwrap();
        let app = app(dir.path());
        assert_eq!(call(&app, "GET", "/", "", "localhost:3000").await, (200, json!("<h1>Capri</h1>")));
    }
}

//! MCP servers, connected from this server, as listed in mcp.json on this machine. The settings page can add
//! servers reached by URL (see mcp_config.rs); a command, which would run here, only ever comes from editing the file.
//! A small client of its own: JSON-RPC over a child's stdio (one message per line) or over streamable HTTP.
use crate::infos;
use crate::mcp_config::{safe_name, shown_url, with_server, without_server, NewServer, INFOS_SERVER, INFOS_USE_CASE};
use crate::store::Store;
use crate::util::{len16, slice16};
use futures_util::future::join_all;
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(20);
const CALL_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_RESULT: usize = 16_000;
const PROTOCOL: &str = "2025-06-18";

type Pending = Arc<StdMutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>>;

fn http() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| reqwest::Client::builder().build().expect("http client"))
}

fn timed_out(limit: Duration) -> String {
    format!("pas de réponse après {} s", limit.as_secs())
}

/// The `result` of a JSON-RPC answer, or its error message.
fn outcome(message: &Value) -> Result<Value, String> {
    match message.get("error") {
        Some(e) => Err(e.get("message").and_then(Value::as_str).map(String::from).unwrap_or_else(|| e.to_string())),
        None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
    }
}

// ---- Child process, one JSON message per line ----

struct Pipe {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next: AtomicU64,
    _child: Child, // killed when the connection is dropped
}

async fn send_line(stdin: &Mutex<ChildStdin>, message: &Value) -> std::io::Result<()> {
    let mut line = message.to_string();
    line.push('\n');
    let mut stdin = stdin.lock().await;
    stdin.write_all(line.as_bytes()).await?;
    stdin.flush().await
}

/// The variables the SDK passes by default, so a server never inherits her keys by accident.
fn safe_environment() -> Vec<(String, String)> {
    let names: &[&str] = if cfg!(windows) {
        &["APPDATA", "HOMEDRIVE", "HOMEPATH", "LOCALAPPDATA", "PATH", "PROCESSOR_ARCHITECTURE", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERNAME", "USERPROFILE", "PROGRAMFILES"]
    } else {
        &["HOME", "LOGNAME", "PATH", "SHELL", "TERM", "USER"]
    };
    names.iter().filter_map(|n| std::env::var(n).ok().filter(|v| !v.starts_with("()")).map(|v| (n.to_string(), v))).collect()
}

impl Pipe {
    fn spawn(config: &Value) -> Result<Pipe, String> {
        let command = config.get("command").and_then(Value::as_str).ok_or("Il manque « command » ou « url » pour ce serveur.")?;
        let args: Vec<String> = config.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(|v| v.as_str().map(String::from)).collect()).unwrap_or_default();
        // npx and friends are .cmd files on Windows.
        let mut cmd = if cfg!(windows) {
            let mut c = Command::new("cmd");
            c.arg("/c").arg(command);
            c
        } else {
            Command::new(command)
        };
        cmd.args(&args).env_clear().envs(safe_environment());
        if let Some(env) = config.get("env").and_then(Value::as_object) {
            cmd.envs(env.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))));
        }
        #[cfg(windows)]
        cmd.creation_flags(0x0800_0000); // no console window
        let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().map_err(|e| e.to_string())?;
        let stdin = Arc::new(Mutex::new(child.stdin.take().ok_or("pas d'entrée")?));
        let stdout = child.stdout.take().ok_or("pas de sortie")?;
        let pending: Pending = Arc::default();
        tokio::spawn(read_lines(stdout, pending.clone(), stdin.clone()));
        Ok(Pipe { stdin, pending, next: AtomicU64::new(1), _child: child })
    }

    async fn request(&self, method: &str, params: Value, limit: Duration) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        if let Err(e) = send_line(&self.stdin, &json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })).await {
            self.pending.lock().unwrap().remove(&id);
            return Err(e.to_string());
        }
        match tokio::time::timeout(limit, rx).await {
            Ok(Ok(answer)) => answer,
            Ok(Err(_)) => Err("le serveur s'est arrêté".into()),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                Err(timed_out(limit))
            }
        }
    }
}

async fn read_lines(stdout: tokio::process::ChildStdout, pending: Pending, stdin: Arc<Mutex<ChildStdin>>) {
    let mut lines = BufReader::new(stdout).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        let id = message.get("id").cloned();
        if message.get("method").is_some() {
            // The server asks something. Ping gets an answer, the rest is declined, so it never waits on us.
            if let Some(id) = id {
                let reply = if message["method"] == "ping" { json!({ "jsonrpc": "2.0", "id": id, "result": {} }) } else { json!({ "jsonrpc": "2.0", "id": id, "error": { "code": -32601, "message": "Method not found" } }) };
                let _ = send_line(&stdin, &reply).await;
            }
        } else if let Some(id) = id.and_then(|i| i.as_u64()) {
            if let Some(tx) = pending.lock().unwrap().remove(&id) {
                let _ = tx.send(outcome(&message));
            }
        }
    }
    pending.lock().unwrap().clear(); // the senders drop, so every waiter learns the server is gone
}

// ---- Streamable HTTP ----

struct Http {
    url: String,
    headers: Vec<(String, String)>,
    session: StdMutex<Option<String>>,
    version: StdMutex<Option<String>>,
    next: AtomicU64,
}

/// The message answering `id`, from a JSON body or from an event stream.
fn answer_in(body: &str, as_stream: bool, id: u64) -> Option<Value> {
    let is_answer = |m: &Value| m.get("id").and_then(Value::as_u64) == Some(id) && m.get("method").is_none();
    if !as_stream {
        return match serde_json::from_str::<Value>(body).ok()? {
            Value::Array(all) => all.into_iter().find(is_answer),
            one => is_answer(&one).then_some(one),
        };
    }
    body.replace("\r\n", "\n").split("\n\n").find_map(|event| {
        let data: Vec<&str> = event.lines().filter_map(|l| l.strip_prefix("data:")).map(|d| d.strip_prefix(' ').unwrap_or(d)).collect();
        serde_json::from_str::<Value>(&data.join("\n")).ok().filter(is_answer)
    })
}

impl Http {
    async fn post(&self, body: &Value, id: Option<u64>, limit: Duration) -> Result<Option<Value>, String> {
        let mut request = http().post(&self.url).timeout(limit).header("Content-Type", "application/json").header("Accept", "application/json, text/event-stream");
        for (k, v) in &self.headers {
            request = request.header(k.as_str(), v.as_str());
        }
        if let Some(s) = self.session.lock().unwrap().as_ref() {
            request = request.header("Mcp-Session-Id", s.as_str());
        }
        if let Some(v) = self.version.lock().unwrap().as_ref() {
            request = request.header("MCP-Protocol-Version", v.as_str());
        }
        let res = request.body(body.to_string()).send().await.map_err(|e| if e.is_timeout() { timed_out(limit) } else { e.to_string() })?;
        if !res.status().is_success() {
            return Err(format!("HTTP {}", res.status().as_u16()));
        }
        if let Some(s) = res.headers().get("mcp-session-id").and_then(|v| v.to_str().ok()) {
            *self.session.lock().unwrap() = Some(s.to_string());
        }
        let Some(id) = id else { return Ok(None) };
        let as_stream = res.headers().get("content-type").and_then(|v| v.to_str().ok()).is_some_and(|t| t.contains("text/event-stream"));
        let text = res.text().await.map_err(|e| if e.is_timeout() { timed_out(limit) } else { e.to_string() })?;
        answer_in(&text, as_stream, id).map(Some).ok_or_else(|| "réponse MCP illisible".to_string())
    }

    async fn request(&self, method: &str, params: Value, limit: Duration) -> Result<Value, String> {
        let id = self.next.fetch_add(1, Ordering::SeqCst);
        let answer = self.post(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }), Some(id), limit).await?;
        outcome(&answer.unwrap_or(Value::Null))
    }
}

// ---- One connection, whatever it talks to ----

enum Client {
    Builtin(Arc<Store>),
    Pipe(Pipe),
    Http(Http),
}

impl Client {
    async fn request(&self, method: &str, params: Value, limit: Duration) -> Result<Value, String> {
        match self {
            Client::Builtin(store) => match method {
                "tools/list" => Ok(json!({ "tools": infos::tools().iter().map(|t| json!({ "name": t.name, "description": t.description, "inputSchema": t.input_schema })).collect::<Vec<_>>() })),
                _ => {
                    let name = params["name"].as_str().unwrap_or("");
                    let args = params["arguments"].as_object().cloned().unwrap_or_default();
                    Ok(match infos::run(store, name, &args).await {
                        Ok(text) => json!({ "content": [{ "type": "text", "text": text }] }),
                        Err(text) => json!({ "content": [{ "type": "text", "text": text }], "isError": true }),
                    })
                }
            },
            Client::Pipe(p) => p.request(method, params, limit).await,
            Client::Http(h) => h.request(method, params, limit).await,
        }
    }

    async fn handshake(&self) -> Result<(), String> {
        let init = json!({ "protocolVersion": PROTOCOL, "capabilities": {}, "clientInfo": { "name": "capri-web", "version": "0.1.0" } });
        match self {
            Client::Builtin(_) => Ok(()),
            Client::Pipe(p) => {
                p.request("initialize", init, CONNECT_TIMEOUT).await?;
                send_line(&p.stdin, &json!({ "jsonrpc": "2.0", "method": "notifications/initialized" })).await.map_err(|e| e.to_string())
            }
            Client::Http(h) => {
                let answer = h.request("initialize", init, CONNECT_TIMEOUT).await?;
                *h.version.lock().unwrap() = Some(answer.get("protocolVersion").and_then(Value::as_str).unwrap_or(PROTOCOL).to_string());
                h.post(&json!({ "jsonrpc": "2.0", "method": "notifications/initialized" }), None, CONNECT_TIMEOUT).await.map(|_| ())
            }
        }
    }
}

struct ToolInfo {
    name: String, // as the model sees it
    tool: String, // as the server calls it
    description: Option<String>,
    input_schema: Value,
}

struct Server {
    name: String,
    url: Option<String>,
    use_case: Option<String>,
    client: Option<Client>,
    error: Option<String>,
    tools: Vec<ToolInfo>,
}

async fn open(name: &str, config: &Value, built_in: Option<Arc<Store>>) -> Result<(Client, Vec<ToolInfo>), String> {
    let client = match (built_in, config.get("url").and_then(Value::as_str)) {
        (Some(store), _) => Client::Builtin(store),
        (None, Some(url)) => {
            let headers = config.get("headers").and_then(Value::as_object).map(|h| h.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect()).unwrap_or_default();
            Client::Http(Http { url: url.to_string(), headers, session: StdMutex::new(None), version: StdMutex::new(None), next: AtomicU64::new(1) })
        }
        (None, None) => Client::Pipe(Pipe::spawn(config)?),
    };
    client.handshake().await?;
    let mut tools = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let params = cursor.as_ref().map(|c| json!({ "cursor": c })).unwrap_or_else(|| json!({}));
        let page = client.request("tools/list", params, CONNECT_TIMEOUT).await?;
        for t in page.get("tools").and_then(Value::as_array).into_iter().flatten() {
            let Some(tool) = t.get("name").and_then(Value::as_str) else { continue };
            tools.push(ToolInfo {
                name: slice16(&format!("{}__{}", safe_name(name), safe_name(tool)), 64),
                tool: tool.to_string(),
                description: t.get("description").and_then(Value::as_str).map(String::from),
                input_schema: t.get("inputSchema").cloned().unwrap_or(Value::Null),
            });
        }
        cursor = page.get("nextCursor").and_then(Value::as_str).filter(|c| !c.is_empty()).map(String::from);
        if cursor.is_none() {
            return Ok((client, tools));
        }
    }
}

/// Connects one server and lists its tools. A failure is kept on the server entry, so the others still work.
async fn connect(name: &str, config: &Value, built_in: Option<Arc<Store>>) -> Server {
    let text = |k: &str| config.get(k).and_then(Value::as_str).map(String::from);
    let mut server = Server { name: name.to_string(), url: text("url"), use_case: text("useCase"), client: None, error: None, tools: vec![] };
    match open(name, config, built_in).await {
        Ok((client, tools)) => {
            server.client = Some(client);
            server.tools = tools;
        }
        Err(error) => server.error = Some(error),
    }
    server
}

struct State {
    stamp: u128,
    error: Option<String>,
    servers: Vec<Server>,
}

pub struct Mcp {
    config: PathBuf,
    store: Arc<Store>,
    /// One change at a time: two requests noticing a new mcp.json together would each start every server.
    current: Mutex<Option<Arc<State>>>,
}

fn stamp_of(path: &PathBuf) -> u128 {
    std::fs::metadata(path).and_then(|m| m.modified()).ok().and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok()).map(|d| d.as_nanos().max(1)).unwrap_or(0)
}

impl Mcp {
    pub fn new(config: PathBuf, store: Arc<Store>) -> Mcp {
        Mcp { config, store, current: Mutex::new(None) }
    }

    /// Reuses the connections until mcp.json changes, or until a reload is asked for.
    async fn state(&self, reload: bool) -> Arc<State> {
        let mut slot = self.current.lock().await;
        let stamp = stamp_of(&self.config);
        if let Some(state) = slot.as_ref().filter(|s| s.stamp == stamp && !reload) {
            return state.clone();
        }
        *slot = None; // closes the old connections
        let mut error = None;
        let mut entries: Vec<(String, Value)> = vec![];
        if stamp != 0 {
            match std::fs::read_to_string(&self.config).map_err(|e| e.to_string()).and_then(|raw| serde_json::from_str::<Value>(&raw).map_err(|e| e.to_string())) {
                Ok(config) => entries = config.get("mcpServers").and_then(Value::as_object).map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()).unwrap_or_default(),
                Err(e) => error = Some(format!("mcp.json illisible : {e}")),
            }
        }
        let own_config = json!({ "useCase": INFOS_USE_CASE });
        let own = connect(INFOS_SERVER, &own_config, Some(self.store.clone()));
        let others = join_all(entries.iter().map(|(name, config)| connect(name, config, None)));
        let (mut servers, own) = tokio::join!(others, own);
        servers.push(own);
        let state = Arc::new(State { stamp, error, servers });
        *slot = Some(state.clone());
        state
    }

    /// What the settings page shows: each server, whether it connected, and its tools.
    pub async fn status(&self, reload: bool) -> Value {
        let state = self.state(reload).await;
        let servers: Vec<Value> = state
            .servers
            .iter()
            .map(|s| {
                let mut o = Map::new();
                o.insert("name".into(), json!(s.name));
                if let Some(u) = s.url.as_ref().filter(|u| !u.is_empty()) {
                    o.insert("url".into(), json!(shown_url(u)));
                }
                if let Some(u) = &s.use_case {
                    o.insert("useCase".into(), json!(u));
                }
                o.insert("connected".into(), json!(s.client.is_some()));
                if let Some(e) = &s.error {
                    o.insert("error".into(), json!(e));
                }
                o.insert("tools".into(), json!(s.tools.iter().map(|t| json!({ "name": t.name, "tool": t.tool })).collect::<Vec<_>>()));
                Value::Object(o)
            })
            .collect();
        let mut out = Map::new();
        if let Some(e) = &state.error {
            out.insert("error".into(), json!(e));
        }
        out.insert("servers".into(), Value::Array(servers));
        Value::Object(out)
    }

    /// The tools in the form the chat API expects.
    pub async fn chat_tools(&self) -> Vec<Value> {
        let state = self.state(false).await;
        state
            .servers
            .iter()
            .flat_map(|s| {
                s.tools.iter().map(move |t| {
                    let about = t.description.clone().unwrap_or_else(|| t.tool.clone());
                    let description = match s.use_case.as_deref().filter(|u| !u.is_empty()) {
                        Some(u) => format!("{about}\n[Server \"{}\", to use for: {u}]", s.name),
                        None => about,
                    };
                    json!({ "type": "function", "function": { "name": t.name, "description": description, "parameters": t.input_schema } })
                })
            })
            .collect()
    }

    /// Refuses to touch a file it can't read: rewriting it would lose whatever is in there.
    /// Ok(Some(problem)) is a refusal the page can show; Err is a failure.
    async fn change_config(&self, change: impl FnOnce(&Value) -> Result<Value, String>) -> Result<Option<String>, String> {
        let _turn = self.current.lock().await;
        let raw = match std::fs::read_to_string(&self.config) {
            Ok(raw) => raw,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => "{}".into(),
            Err(e) => return Err(e.to_string()),
        };
        let current: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
        let next = match change(&current) {
            Ok(next) => next,
            Err(problem) => return Ok(Some(problem)),
        };
        let draft = PathBuf::from(format!("{}.tmp", self.config.display()));
        write_private(&draft, &format!("{}\n", serde_json::to_string_pretty(&next).map_err(|e| e.to_string())?)).map_err(|e| e.to_string())?;
        std::fs::rename(&draft, &self.config).map_err(|e| e.to_string())?; // all or nothing, so a crash can't leave half a file
        Ok(None)
    }

    pub async fn add_server(&self, server: &NewServer) -> Result<Option<String>, String> {
        self.change_config(|config| with_server(config, server)).await
    }

    pub async fn remove_server(&self, name: &str) -> Result<Option<String>, String> {
        self.change_config(|config| without_server(config, name)).await
    }

    /// Runs a tool by its chat name, cutting a huge result. None if no server has it.
    pub async fn call_tool(&self, name: &str, args: &Map<String, Value>) -> Result<Option<Value>, String> {
        let state = self.state(false).await;
        for server in &state.servers {
            let (Some(tool), Some(client)) = (server.tools.iter().find(|t| t.name == name), &server.client) else { continue };
            let result = client.request("tools/call", json!({ "name": tool.tool, "arguments": args }), CALL_TIMEOUT).await?;
            let parts = result.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
            let text = parts
                .iter()
                .map(|p| match p.get("type").and_then(Value::as_str) {
                    Some("text") => p.get("text").and_then(Value::as_str).unwrap_or("undefined").to_string(),
                    other => format!("[contenu {} non affiché]", other.unwrap_or("undefined")),
                })
                .collect::<Vec<_>>()
                .join("\n");
            let text = if text.is_empty() { "(aucun contenu)".to_string() } else { text };
            let text = if len16(&text) > MAX_RESULT { format!("{}\n[résultat coupé]", slice16(&text, MAX_RESULT)) } else { text };
            return Ok(Some(json!({ "text": text, "isError": result.get("isError").is_some_and(|e| !matches!(e, Value::Null | Value::Bool(false))) })));
        }
        Ok(None)
    }
}

fn write_private(path: &PathBuf, text: &str) -> std::io::Result<()> {
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

#[cfg(test)]
mod tests {
    use super::*;

    const FAKE: &str = r#"const rl = require("readline").createInterface({ input: process.stdin });
rl.on("line", (l) => {
  const m = JSON.parse(l);
  if (m.id === undefined) return;
  const r = (result) => console.log(JSON.stringify({ jsonrpc: "2.0", id: m.id, result }));
  if (m.method === "initialize") r({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "t", version: "1" } });
  else if (m.method === "tools/list") r({ tools: [{ name: "echo it", description: "Echo", inputSchema: { type: "object" } }] });
  else r({ content: [{ type: "text", text: "echo:" + JSON.stringify(m.params.arguments) }, { type: "image" }] });
});"#;

    fn node_exists() -> bool {
        std::process::Command::new("node").arg("-v").output().is_ok_and(|o| o.status.success())
    }

    #[test]
    fn an_answer_is_found_in_a_json_body_or_an_event_stream() {
        let body = r#"{"jsonrpc":"2.0","id":3,"result":{"ok":true}}"#;
        assert_eq!(answer_in(body, false, 3).unwrap()["result"]["ok"], true);
        assert!(answer_in(body, false, 4).is_none());
        let stream = "event: message\r\ndata: {\"jsonrpc\":\"2.0\",\"method\":\"notifications/progress\"}\r\n\r\nevent: message\r\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{\"ok\":1}}\r\n\r\n";
        assert_eq!(answer_in(stream, true, 3).unwrap()["result"]["ok"], 1);
        assert_eq!(outcome(&json!({ "error": { "message": "nope" } })), Err("nope".into()));
    }

    #[tokio::test]
    async fn the_built_in_tools_are_always_there_and_a_stdio_server_from_mcp_json_works() {
        let dir = tempfile::tempdir().unwrap();
        let store = Arc::new(Store::open(":memory:").unwrap());
        let config = dir.path().join("mcp.json");
        let mcp = Mcp::new(config.clone(), store.clone());

        let status = mcp.status(false).await; // no file yet: only the built-in server
        assert_eq!(status["servers"].as_array().unwrap().len(), 1);
        assert_eq!(status["servers"][0]["name"], INFOS_SERVER);
        assert_eq!(status["servers"][0]["connected"], true);
        assert_eq!(status["servers"][0]["tools"][0]["name"], "Capri_Infos__heure");
        let sum = mcp.call_tool("Capri_Infos__calcul", json!({ "expression": "2+2" }).as_object().unwrap()).await.unwrap().unwrap();
        assert_eq!(sum, json!({ "text": "4", "isError": false }));
        let bad = mcp.call_tool("Capri_Infos__calcul", json!({ "expression": "(" }).as_object().unwrap()).await.unwrap().unwrap();
        assert_eq!(bad["isError"], true);
        assert!(mcp.call_tool("nobody__nothing", &Map::new()).await.unwrap().is_none());

        // The page adds a server by URL, then removes it; the file stays valid JSON the whole time.
        let site = NewServer { name: "Site".into(), url: "http://127.0.0.1:1/mcp".into(), use_case: "Tests.".into(), headers: None };
        assert_eq!(mcp.add_server(&site).await, Ok(None));
        assert!(mcp.add_server(&site).await.unwrap().unwrap().contains("existe déjà"));
        let added = mcp.status(false).await;
        assert_eq!(added["servers"][0]["name"], "Site");
        assert_eq!(added["servers"][0]["connected"], false); // nothing listens there, and the others still work
        assert_eq!(mcp.remove_server("Site").await, Ok(None));
        assert!(mcp.remove_server("Site").await.unwrap().is_some());

        if !node_exists() {
            return;
        }
        let script = dir.path().join("fake.js");
        std::fs::write(&script, FAKE).unwrap();
        std::fs::write(&config, json!({ "mcpServers": { "fake": { "command": "node", "args": [script.to_str().unwrap()], "useCase": "Echo." } } }).to_string()).unwrap();
        let status = mcp.status(true).await;
        assert_eq!(status["servers"][0]["connected"], true, "{status}");
        assert_eq!(status["servers"][0]["tools"][0]["name"], "fake__echo_it");
        let tools = mcp.chat_tools().await;
        assert!(tools.iter().any(|t| t["function"]["description"] == "Echo\n[Server \"fake\", to use for: Echo.]"));
        let echoed = mcp.call_tool("fake__echo_it", json!({ "a": 1 }).as_object().unwrap()).await.unwrap().unwrap();
        assert_eq!(echoed["text"], "echo:{\"a\":1}\n[contenu image non affiché]");

        std::fs::write(&config, "{ pas du json").unwrap();
        assert!(mcp.status(false).await["error"].as_str().unwrap().starts_with("mcp.json illisible"));
        assert!(mcp.add_server(&site).await.is_err()); // never rewrites a file it can't read
        assert_eq!(std::fs::read_to_string(&config).unwrap(), "{ pas du json");
    }
}

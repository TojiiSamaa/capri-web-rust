//! Her memory on this machine: settings, keys and chats in data/capri.db. Keys never leave the server.
use crate::messages::{parse_brain, Brain};
use crate::util::js_trim;
use rusqlite::{params, Connection};
use serde_json::{json, Map, Value};
use std::path::Path;
use std::sync::Mutex;

pub type Row = Map<String, Value>;
const SECRETS: [&str; 2] = ["apiKey", "elevenKey"];
const NOT_STORED: [&str; 4] = ["apiKey", "elevenKey", "apiKeySet", "elevenKeySet"];

/// Her longest memory: older messages stay in the file but are never sent to the page or the model.
pub const RECENT: usize = 32;

const DEFAULTS: &str = include_str!("../../shared/defaults.json");

pub fn defaults() -> Row {
    serde_json::from_str(DEFAULTS).expect("shared/defaults.json")
}

fn settings_only(from: &Row) -> Row {
    from.iter().filter(|(k, _)| !NOT_STORED.contains(&k.as_str())).map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// Migration from a browser: what was set by hand here is kept, and anything still at its default takes the browser's value.
pub fn merge_settings(stored: &Row, incoming: &Row, defaults: &Row) -> Row {
    let mut merged = stored.clone();
    for (key, value) in settings_only(incoming) {
        if !stored.contains_key(&key) || stored.get(&key) == defaults.get(&key) {
            merged.insert(key, value);
        }
    }
    merged
}

#[derive(Debug, Clone, PartialEq)]
pub struct Reminder {
    pub id: i64,
    pub text: String,
    pub at: i64,
}

pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

pub struct Store {
    db: Mutex<Connection>,
}

fn secrets_of(db: &Connection) -> Row {
    get(db, "secrets").unwrap_or_default()
}

fn get<T: serde::de::DeserializeOwned>(db: &Connection, key: &str) -> Option<T> {
    let value: Option<String> = db.query_row("SELECT value FROM kv WHERE key = ?", [key], |r| r.get(0)).ok();
    value.and_then(|v| serde_json::from_str(&v).ok())
}

fn put(db: &Connection, key: &str, value: &impl serde::Serialize) -> rusqlite::Result<()> {
    db.execute("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", params![key, serde_json::to_string(value).unwrap()])?;
    Ok(())
}

fn append_in(db: &Connection, list: &[Value]) -> rusqlite::Result<()> {
    let mut add = db.prepare("INSERT INTO messages (role, content, at) VALUES (?, ?, ?)")?;
    for m in list {
        if let (Some(role), Some(content)) = (m.get("role").and_then(Value::as_str), m.get("content").and_then(Value::as_str)) {
            add.execute(params![role, content, now_ms()])?;
        }
    }
    Ok(())
}

fn count_in(db: &Connection) -> i64 {
    db.query_row("SELECT count(*) FROM messages", [], |r| r.get(0)).unwrap_or(0)
}

fn save_secrets_in(db: &Connection, next: &Row) -> rusqlite::Result<()> {
    let mut kept = secrets_of(db);
    for name in SECRETS {
        let Some(value) = next.get(name).and_then(Value::as_str).map(|v| js_trim(v).to_string()) else { continue };
        if value.is_empty() {
            kept.remove(name);
        } else {
            kept.insert(name.into(), Value::String(value));
        }
    }
    put(db, "secrets", &kept)
}

impl Store {
    pub fn open(path: &str) -> rusqlite::Result<Store> {
        if path != ":memory:" {
            private_file(Path::new(path));
        }
        let db = Connection::open(path)?;
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at INTEGER NOT NULL);
             CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL);",
        )?;
        // Chats saved before the messages table, moved over once.
        db.execute_batch("BEGIN")?;
        let moved = (|| {
            append_in(&db, &get::<Vec<Value>>(&db, "history").unwrap_or_default())?;
            db.execute("DELETE FROM kv WHERE key = 'history'", [])?;
            Ok::<_, rusqlite::Error>(())
        })();
        db.execute_batch(if moved.is_ok() { "COMMIT" } else { "ROLLBACK" })?;
        moved?;
        Ok(Store { db: Mutex::new(db) })
    }

    fn db(&self) -> std::sync::MutexGuard<'_, Connection> {
        self.db.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn in_turn<T>(&self, run: impl FnOnce(&Connection) -> rusqlite::Result<T>) -> rusqlite::Result<T> {
        let db = self.db();
        db.execute_batch("BEGIN")?;
        match run(&db) {
            Ok(v) => {
                db.execute_batch("COMMIT")?;
                Ok(v)
            }
            Err(e) => {
                db.execute_batch("ROLLBACK")?;
                Err(e)
            }
        }
    }

    /// What the page gets: whether each key is set, never the key.
    pub fn read(&self) -> Value {
        let db = self.db();
        let known = secrets_of(&db);
        let mut settings: Row = get(&db, "settings").unwrap_or_default();
        settings.insert("apiKeySet".into(), json!(known.get("apiKey").is_some_and(|k| !k.as_str().unwrap_or("").is_empty())));
        settings.insert("elevenKeySet".into(), json!(known.get("elevenKey").is_some_and(|k| !k.as_str().unwrap_or("").is_empty())));
        let mut recent: Vec<Value> = db
            .prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?")
            .and_then(|mut q| q.query_map([RECENT], |r| Ok(json!({ "role": r.get::<_, String>(0)?, "content": r.get::<_, String>(1)? }))).and_then(|rows| rows.collect()))
            .unwrap_or_default();
        recent.reverse();
        json!({ "settings": settings, "history": recent, "historyCount": count_in(&db) })
    }

    pub fn settings(&self) -> Row {
        get(&self.db(), "settings").unwrap_or_default()
    }
    pub fn secrets(&self) -> Row {
        secrets_of(&self.db())
    }
    pub fn secret(&self, name: &str) -> String {
        self.secrets().get(name).and_then(Value::as_str).unwrap_or("").to_string()
    }
    pub fn save_settings(&self, settings: &Row) -> rusqlite::Result<()> {
        put(&self.db(), "settings", &settings_only(settings))
    }
    pub fn save_secrets(&self, next: &Row) -> rusqlite::Result<()> {
        save_secrets_in(&self.db(), next)
    }
    pub fn append(&self, list: &[Value]) -> rusqlite::Result<()> {
        self.in_turn(|db| append_in(db, list))
    }
    pub fn clear_history(&self) -> rusqlite::Result<()> {
        self.db().execute("DELETE FROM messages", []).map(|_| ())
    }

    /// All or nothing. A second browser's chat can't be placed in time, so it stays in the file the route has already written.
    pub fn migrate(&self, settings: &Row, history: &[Value]) -> rusqlite::Result<()> {
        self.in_turn(|db| {
            put(db, "settings", &merge_settings(&get(db, "settings").unwrap_or_default(), settings, &defaults()))?;
            let known = secrets_of(db);
            let mut missing = Row::new();
            for name in SECRETS {
                let has = known.get(name).and_then(Value::as_str).is_some_and(|k| !k.is_empty());
                if let (false, Some(v @ Value::String(_))) = (has, settings.get(name)) {
                    missing.insert(name.into(), v.clone());
                }
            }
            save_secrets_in(db, &missing)?;
            if count_in(db) == 0 {
                append_in(db, history)?;
            }
            Ok(())
        })
    }

    pub fn add_reminder(&self, text: &str, at: i64) -> rusqlite::Result<i64> {
        let db = self.db();
        db.execute("INSERT INTO reminders (text, at) VALUES (?, ?)", params![text, at])?;
        Ok(db.last_insert_rowid())
    }
    pub fn reminders(&self) -> Vec<Reminder> {
        let db = self.db();
        let mut q = db.prepare("SELECT id, text, at FROM reminders ORDER BY at").unwrap();
        q.query_map([], |r| Ok(Reminder { id: r.get(0)?, text: r.get(1)?, at: r.get(2)? })).unwrap().filter_map(Result::ok).collect()
    }
    pub fn cancel_reminder(&self, id: i64) -> bool {
        self.db().execute("DELETE FROM reminders WHERE id = ?", [id]).is_ok_and(|n| n > 0)
    }
    /// One statement, so a reminder can't be handed out twice.
    pub fn take_due_reminders(&self, now: i64) -> Vec<Reminder> {
        let db = self.db();
        let mut q = db.prepare("DELETE FROM reminders WHERE at <= ? RETURNING id, text, at").unwrap();
        let mut due: Vec<Reminder> = q.query_map([now], |r| Ok(Reminder { id: r.get(0)?, text: r.get(1)?, at: r.get(2)? })).unwrap().filter_map(Result::ok).collect();
        due.sort_by_key(|r| r.at);
        due
    }

    /// The brain as saved, with the server's environment underneath. The page has no say in where the key goes.
    pub fn saved_brain(&self) -> Option<Brain> {
        let settings = self.settings();
        let body = json!({ "baseUrl": settings.get("baseUrl"), "model": settings.get("model"), "apiKey": self.secret("apiKey") });
        parse_brain(&body, &|name| std::env::var(name).ok())
    }
}

/// Private before SQLite first opens it, and if the file was already there. Windows has no POSIX modes.
fn private_file(path: &Path) {
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700));
        }
    }
    let _ = std::fs::OpenOptions::new().create(true).append(true).open(path);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(v: Value) -> Row {
        v.as_object().unwrap().clone()
    }
    fn said(content: &str) -> Value {
        json!({ "role": "user", "content": content })
    }

    #[test]
    fn the_page_gets_flags_never_the_keys_even_if_it_tries_to_save_them_as_settings() {
        let s = Store::open(":memory:").unwrap();
        s.save_settings(&row(json!({ "model": "m", "apiKey": "sk-page", "apiKeySet": true }))).unwrap();
        s.save_secrets(&row(json!({ "apiKey": " sk-real " }))).unwrap();
        let read = s.read();
        assert_eq!(read["settings"], json!({ "model": "m", "apiKeySet": true, "elevenKeySet": false }));
        assert_eq!(read["history"], json!([]));
        assert!(!read.to_string().contains("sk-"));
        assert_eq!(s.secret("apiKey"), "sk-real");
    }

    #[test]
    fn an_empty_key_deletes_it_a_key_left_out_stays() {
        let s = Store::open(":memory:").unwrap();
        s.save_secrets(&row(json!({ "apiKey": "a", "elevenKey": "b" }))).unwrap();
        s.save_secrets(&row(json!({ "elevenKey": "" }))).unwrap();
        assert_eq!(Value::Object(s.secrets()), json!({ "apiKey": "a" }));
    }

    #[test]
    fn migration_moves_keys_out_of_the_settings_and_keeps_nothing_behind() {
        let s = Store::open(":memory:").unwrap();
        s.migrate(&row(json!({ "model": "gpt", "apiKey": "sk-old", "elevenKey": "" })), &[said("salut")]).unwrap();
        assert_eq!(Value::Object(s.settings()), json!({ "model": "gpt" }));
        assert_eq!(Value::Object(s.secrets()), json!({ "apiKey": "sk-old" }));
        assert_eq!(s.read()["history"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn a_second_browser_fills_the_gaps_and_overwrites_nothing() {
        let s = Store::open(":memory:").unwrap();
        s.migrate(&row(json!({ "model": "first", "apiKey": "sk-first", "look": 0 })), &[said("a"), said("b"), said("c")]).unwrap();
        s.migrate(&row(json!({ "model": "second", "apiKey": "sk-second", "look": 2 })), &[said("autre"), said("autre"), said("autre"), said("autre")]).unwrap();
        assert_eq!(s.settings()["model"], "first");
        assert_eq!(s.settings()["look"], 2); // 0 is the default, so it was never really chosen
        assert_eq!(s.secret("apiKey"), "sk-first");
        assert_eq!(s.read()["history"], json!([said("a"), said("b"), said("c")]));
    }

    #[test]
    fn everything_is_kept_only_the_end_comes_back_and_order_holds() {
        let s = Store::open(":memory:").unwrap();
        for i in 0..RECENT + 10 {
            s.append(&[said(&format!("m{i}"))]).unwrap();
        }
        let read = s.read();
        assert_eq!(read["historyCount"], RECENT + 10);
        let history = read["history"].as_array().unwrap();
        assert_eq!(history.len(), RECENT);
        assert_eq!(history[0]["content"], "m10");
        assert_eq!(history.last().unwrap()["content"], format!("m{}", RECENT + 9));
        s.append(&[json!({ "role": "user" }), json!("junk"), Value::Null]).unwrap();
        assert_eq!(s.read()["historyCount"], RECENT + 10);
        s.clear_history().unwrap();
        assert_eq!(s.read()["historyCount"], 0);
    }

    #[test]
    fn a_chat_from_the_old_format_moves_to_the_messages_table_once_in_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("t.db");
        let old = Connection::open(&path).unwrap();
        old.execute_batch("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)").unwrap();
        let history = json!([{ "role": "user", "content": "vieux" }, { "role": "assistant", "content": "message" }]);
        old.execute("INSERT INTO kv VALUES ('history', ?)", [history.to_string()]).unwrap();
        drop(old);
        for _ in 0..2 {
            let s = Store::open(path.to_str().unwrap()).unwrap();
            assert_eq!(s.read()["history"], history);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        }
    }

    #[test]
    fn merge_compares_lists_by_value() {
        let empty = row(json!({ "mcpAllowed": [] }));
        assert_eq!(Value::Object(merge_settings(&empty, &row(json!({ "mcpAllowed": ["x"] })), &empty)), json!({ "mcpAllowed": ["x"] }));
        assert_eq!(Value::Object(merge_settings(&row(json!({ "mcpAllowed": ["y"] })), &row(json!({ "mcpAllowed": ["x"] })), &empty)), json!({ "mcpAllowed": ["y"] }));
    }

    #[test]
    fn reminders_are_handed_over_once_in_order() {
        let s = Store::open(":memory:").unwrap();
        let (a, b) = (s.add_reminder("a", 200).unwrap(), s.add_reminder("b", 100).unwrap());
        assert_eq!((a, b), (1, 2));
        assert!(s.cancel_reminder(a) && !s.cancel_reminder(a));
        s.add_reminder("c", 300).unwrap();
        assert!(s.take_due_reminders(50).is_empty());
        assert_eq!(s.take_due_reminders(1000).iter().map(|r| r.text.as_str()).collect::<Vec<_>>(), ["b", "c"]);
        assert!(s.take_due_reminders(1000).is_empty());
    }
}

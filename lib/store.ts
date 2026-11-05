// Her memory on this machine: settings, keys and chats in data/capri.db. Keys never leave the server.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseBrain } from "./messages.ts";
import { DEFAULTS } from "./settings.ts";

type Row = Record<string, unknown>;
export type Reminder = { id: number; text: string; at: number };
const SECRETS = ["apiKey", "elevenKey"] as const;
export type Secrets = Partial<Record<(typeof SECRETS)[number], string>>;
const NOT_STORED = new Set<string>([...SECRETS, "apiKeySet", "elevenKeySet"]);

const settingsOnly = (from: Row) => Object.fromEntries(Object.entries(from).filter(([key]) => !NOT_STORED.has(key)));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Migration from a browser: what was set by hand here is kept, and anything still at its default takes the browser's value.
export function mergeSettings(stored: Row, incoming: Row, defaults: Row = DEFAULTS) {
  const merged = { ...stored };
  for (const [key, value] of Object.entries(settingsOnly(incoming))) {
    if (!(key in stored) || same(stored[key], defaults[key])) merged[key] = value;
  }
  return merged;
}

type Saved = { role: string; content: string };
const isSaved = (m: unknown): m is Saved => typeof (m as Saved)?.role === "string" && typeof (m as Saved)?.content === "string";

// Her longest memory: older messages stay in the file but are never sent to the page or the model.
export const RECENT = 32;

export function openStore(path: string) {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, "", { flag: "a", mode: 0o600 }); // private before SQLite first opens it
    chmodSync(path, 0o600); // and if the file was already there
  }
  const db = new DatabaseSync(path);
  db.exec("CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS reminders (id INTEGER PRIMARY KEY AUTOINCREMENT, text TEXT NOT NULL, at INTEGER NOT NULL)");
  db.exec("CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY AUTOINCREMENT, role TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL)");
  const get = <T>(key: string, fallback: T): T => {
    const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  };
  const put = (key: string, value: unknown) =>
    db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));

  const inTurn = <T>(run: () => T) => {
    db.exec("BEGIN");
    try {
      const result = run();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  };
  const append = (list: unknown[]) => {
    const add = db.prepare("INSERT INTO messages (role, content, at) VALUES (?, ?, ?)");
    for (const m of list) if (isSaved(m)) add.run(m.role, m.content, Date.now());
  };
  const count = () => (db.prepare("SELECT count(*) AS n FROM messages").get() as { n: number }).n;

  // Chats saved before the messages table, moved over once.
  inTurn(() => {
    append(get<unknown[]>("history", []));
    db.prepare("DELETE FROM kv WHERE key = 'history'").run();
  });

  const secrets = () => get<Secrets>("secrets", {});
  const saveSecrets = (next: Secrets) => {
    const kept = secrets();
    for (const name of SECRETS) {
      const value = next[name]?.trim();
      if (value) kept[name] = value;
      else if (value !== undefined) delete kept[name];
    }
    put("secrets", kept);
  };

  return {
    // What the page gets: whether each key is set, never the key.
    read() {
      const known = secrets();
      const recent = db.prepare("SELECT role, content FROM messages ORDER BY id DESC LIMIT ?").all(RECENT).reverse();
      return { settings: { ...get<Row>("settings", {}), apiKeySet: !!known.apiKey, elevenKeySet: !!known.elevenKey }, history: recent.map((m) => ({ ...m })), historyCount: count() };
    },
    settings: () => get<Row>("settings", {}),
    secrets,
    saveSettings: (settings: Row) => put("settings", settingsOnly(settings)),
    saveSecrets,
    append: (list: unknown[]) => inTurn(() => append(list)),
    clearHistory: () => void db.prepare("DELETE FROM messages").run(),
    // All or nothing. A second browser's chat can't be placed in time, so it stays in the file the route has already written.
    migrate(settings: Row, history: unknown[]) {
      inTurn(() => {
        put("settings", mergeSettings(get<Row>("settings", {}), settings));
        const known = secrets();
        const missing: Secrets = {};
        for (const name of SECRETS) if (!known[name] && typeof settings[name] === "string") missing[name] = settings[name] as string;
        saveSecrets(missing);
        if (!count()) append(history);
      });
    },
    addReminder: (text: string, at: number) => Number(db.prepare("INSERT INTO reminders (text, at) VALUES (?, ?)").run(text, at).lastInsertRowid),
    reminders: () => db.prepare("SELECT id, text, at FROM reminders ORDER BY at").all() as Reminder[],
    cancelReminder: (id: number) => db.prepare("DELETE FROM reminders WHERE id = ?").run(id).changes > 0,
    // One statement, so a reminder can't be handed out twice.
    takeDueReminders: (now: number) => (db.prepare("DELETE FROM reminders WHERE at <= ? RETURNING id, text, at").all(now) as Reminder[]).sort((a, b) => a.at - b.at),
    close: () => db.close(),
  };
}

export const DATA_DIR = join(process.cwd(), "data");

// Kept on globalThis so a hot reload doesn't open the file a second time.
const shared = globalThis as unknown as { capriDb?: ReturnType<typeof openStore> };
export const store = () => (shared.capriDb ??= openStore(join(DATA_DIR, "capri.db")));
export const useStore = (test: ReturnType<typeof openStore>) => void (shared.capriDb = test); // keeps tests out of the real file

// The brain as saved, with the server's .env.local underneath. The page has no say in where the key goes.
export function savedBrain() {
  const { baseUrl, model } = store().settings();
  return parseBrain({ baseUrl, model, apiKey: store().secrets().apiKey }, process.env);
}

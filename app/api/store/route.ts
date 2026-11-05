// The page's door to data/capri.db: settings and chats go through here, keys only ever come in.
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isLocalRequest, refused } from "@/lib/guard";
import { settingsFrom } from "@/lib/settings";
import { DATA_DIR, type Secrets, store } from "@/lib/store";

const MAX_BODY = 12_000_000; // more than a browser's localStorage can hold

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const parsed = (raw: unknown) => {
  try {
    return typeof raw === "string" ? JSON.parse(raw) : null;
  } catch {
    return null; // unreadable in the browser too, and the backup file still has it
  }
};

async function body(req: Request) {
  const raw = await req.text();
  if (raw.length > MAX_BODY) return null;
  try {
    const value = JSON.parse(raw);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  return Response.json(store().read());
}

export async function PUT(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const b = await body(req);
  if (!b) return Response.json({ error: "bad_request" }, { status: 400 });
  const { settings, secrets, append, clearHistory } = b;
  const goodSecrets = isObject(secrets) && Object.values(secrets).every((v) => typeof v === "string" && v.length <= 1000);
  if ((settings !== undefined && !isObject(settings)) || (secrets !== undefined && !goodSecrets) || (append !== undefined && !Array.isArray(append))) {
    return Response.json({ error: "bad_request" }, { status: 400 });
  }
  if (isObject(settings)) store().saveSettings(settings);
  if (goodSecrets) store().saveSecrets(secrets as Secrets);
  if (Array.isArray(append)) store().append(append);
  if (clearHistory === true) store().clearHistory();
  return Response.json({ ok: true });
}

// One browser's localStorage, as it was. Copied to a file first: the page only deletes its own once this answers ok.
export async function POST(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const b = await body(req);
  if (!b) return Response.json({ error: "bad_request" }, { status: 400 });
  const copy = JSON.stringify({ settings: b.settings ?? null, history: b.history ?? null });
  await mkdir(DATA_DIR, { recursive: true, mode: 0o700 });
  await writeFile(join(DATA_DIR, `localStorage-${createHash("sha256").update(copy).digest("hex").slice(0, 12)}.json`), copy, { mode: 0o600 });
  const settings = parsed(b.settings);
  const history = parsed(b.history);
  store().migrate(isObject(settings) ? settingsFrom(settings) : {}, Array.isArray(history) ? history : []);
  return Response.json({ ok: true });
}

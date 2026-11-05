import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import { mergeSettings, openStore, RECENT } from "./store.ts";

test("the page gets flags, never the keys, even if it tries to save them as settings", () => {
  const s = openStore(":memory:");
  s.saveSettings({ model: "m", apiKey: "sk-page", apiKeySet: true });
  s.saveSecrets({ apiKey: " sk-real " });
  const read = s.read();
  assert.deepEqual(read.settings, { model: "m", apiKeySet: true, elevenKeySet: false });
  assert.deepEqual(read.history, []);
  assert.ok(!JSON.stringify(read).includes("sk-"));
  assert.equal(s.secrets().apiKey, "sk-real");
});

test("an empty key deletes it; a key left out stays", () => {
  const s = openStore(":memory:");
  s.saveSecrets({ apiKey: "a", elevenKey: "b" });
  s.saveSecrets({ elevenKey: "" });
  assert.deepEqual(s.secrets(), { apiKey: "a" });
});

test("migration moves keys out of the settings and keeps nothing behind", () => {
  const s = openStore(":memory:");
  s.migrate({ model: "gpt", apiKey: "sk-old", elevenKey: "" }, [{ role: "user", content: "salut" }]);
  assert.deepEqual(s.settings(), { model: "gpt" });
  assert.deepEqual(s.secrets(), { apiKey: "sk-old" });
  assert.equal(s.read().history.length, 1);
});

test("a second browser fills the gaps and overwrites nothing", () => {
  const s = openStore(":memory:");
  const said = (content: string) => ({ role: "user", content });
  s.migrate({ model: "first", apiKey: "sk-first", look: 0 }, [said("a"), said("b"), said("c")]);
  s.migrate({ model: "second", apiKey: "sk-second", look: 2 }, [said("autre"), said("autre"), said("autre"), said("autre")]);
  assert.equal(s.settings().model, "first");
  assert.equal(s.settings().look, 2); // 0 is the default, so it was never really chosen
  assert.equal(s.secrets().apiKey, "sk-first");
  assert.deepEqual(s.read().history, [said("a"), said("b"), said("c")]); // the file written by the route has the other one
});

test("everything is kept, only the end comes back, and order holds", () => {
  const s = openStore(":memory:");
  for (let i = 0; i < RECENT + 10; i++) s.append([{ role: "user", content: `m${i}` }]);
  const { history, historyCount } = s.read();
  assert.equal(historyCount, RECENT + 10);
  assert.equal(history.length, RECENT);
  assert.equal(history[0].content, "m10");
  assert.equal(history.at(-1)!.content, `m${RECENT + 9}`);
  s.append([{ role: "user" }, "junk", null]);
  assert.equal(s.read().historyCount, RECENT + 10);
  s.clearHistory();
  assert.equal(s.read().historyCount, 0);
});

test("a chat from the old format moves to the messages table once, in a real file", () => {
  const dir = mkdtempSync(join(tmpdir(), "capri-"));
  const path = join(dir, "t.db");
  const old = new DatabaseSync(path);
  old.exec("CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  old.prepare("INSERT INTO kv VALUES ('history', ?)").run(JSON.stringify([{ role: "user", content: "vieux" }, { role: "assistant", content: "message" }]));
  old.close();
  for (let open = 0; open < 2; open++) {
    const s = openStore(path);
    assert.deepEqual(s.read().history, [{ role: "user", content: "vieux" }, { role: "assistant", content: "message" }]);
    s.close();
  }
  assert.equal(statSync(path).mode & 0o777, 0o600);
  rmSync(dir, { recursive: true });
});

test("merge compares lists by value", () => {
  assert.deepEqual(mergeSettings({ mcpAllowed: [] }, { mcpAllowed: ["x"] }, { mcpAllowed: [] }), { mcpAllowed: ["x"] });
  assert.deepEqual(mergeSettings({ mcpAllowed: ["y"] }, { mcpAllowed: ["x"] }, { mcpAllowed: [] }), { mcpAllowed: ["y"] });
});

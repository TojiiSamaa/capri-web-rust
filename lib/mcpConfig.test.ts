import assert from "node:assert/strict";
import { test } from "node:test";
import { parseNewServer, shownUrl, withoutServer, withServer } from "./mcpConfig.ts";

const good = { name: "Boîte mail", url: "https://mail.example/mcp", useCase: "Lire les emails." };

test("a new server needs a name, an http(s) URL and a use case", () => {
  assert.deepEqual(parseNewServer({ ...good, name: " Boîte mail ", command: "rm -rf /" }), good);
  for (const bad of [null, {}, { ...good, name: " " }, { ...good, name: "x".repeat(41) }, { ...good, useCase: "" }, { ...good, useCase: "x".repeat(501) }, { ...good, url: "pas une url" }, { ...good, url: "file:///etc/passwd" }, { ...good, url: "javascript:alert(1)" }, { ...good, url: 3 }]) {
    assert.equal(typeof parseNewServer(bad), "string");
  }
});

test("the token becomes a header, and bad ones are refused", () => {
  assert.deepEqual(parseNewServer({ ...good, token: " abc ", tokenKind: "bearer" }), { ...good, headers: { Authorization: "Bearer abc" } });
  assert.deepEqual(parseNewServer({ ...good, token: "abc", tokenKind: "x-api-key" }), { ...good, headers: { "x-api-key": "abc" } });
  assert.deepEqual(parseNewServer({ ...good, token: "  " }), good);
  for (const bad of [{ token: "a b", tokenKind: "bearer" }, { token: "a\r\nX-Evil: 1", tokenKind: "bearer" }, { token: "x".repeat(2001), tokenKind: "bearer" }, { token: "abc" }, { token: "abc", tokenKind: "cookie" }]) {
    assert.equal(typeof parseNewServer({ ...good, ...bad }), "string");
  }
  const added = withServer({}, { ...good, headers: { "x-api-key": "abc" } }) as { mcpServers: Record<string, unknown> };
  assert.deepEqual(added.mcpServers[good.name], { url: good.url, useCase: good.useCase, headers: { "x-api-key": "abc" } });
});

test("a token in a URL is never shown", () => {
  assert.equal(shownUrl("https://a.example/mcp?token=secret"), "https://a.example/mcp?…");
  assert.equal(shownUrl("https://user:secret@a.example/mcp"), "https://a.example/mcp");
  assert.equal(shownUrl("https://a.example/mcp"), "https://a.example/mcp");
});

test("adding keeps what is there and never overwrites", () => {
  const local = { mcpServers: { "mes fichiers": { command: "npx", env: { TOKEN: "t" } } }, autre: 1 };
  const added = withServer(local, good);
  assert.deepEqual(added, { autre: 1, mcpServers: { ...local.mcpServers, "Boîte mail": { url: good.url, useCase: good.useCase } } });
  assert.equal(typeof withServer(local, { ...good, name: "mes_fichiers" }), "string");
  assert.deepEqual(withServer({}, good), { mcpServers: { "Boîte mail": { url: good.url, useCase: good.useCase } } });
  assert.equal(JSON.stringify(withServer(local, good)).includes("headers"), false);
});

test("removing only touches URL servers", () => {
  const config = { mcpServers: { web: { url: "https://x" }, local: { command: "npx" } } };
  assert.deepEqual(withoutServer(config, "web"), { mcpServers: { local: { command: "npx" } } });
  assert.equal(typeof withoutServer(config, "local"), "string");
  assert.equal(typeof withoutServer(config, "absent"), "string");
  assert.equal(typeof withoutServer(config, "constructor"), "string");
});

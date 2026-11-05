import assert from "node:assert/strict";
import { test } from "node:test";
import { isLocalRequest } from "./guard.ts";

const ask = (headers: Record<string, string>) => isLocalRequest(new Headers(headers));

test("this app on this machine gets through", () => {
  assert.ok(ask({ host: "localhost:3000", origin: "http://localhost:3000", "sec-fetch-site": "same-origin" }));
  assert.ok(ask({ host: "127.0.0.1:3000" }));
  assert.ok(ask({ host: "[::1]:3000" }));
});

test("other sites and other hosts don't", () => {
  assert.ok(!ask({ host: "localhost:3000", origin: "https://evil.example", "sec-fetch-site": "cross-site" }));
  assert.ok(!ask({ host: "localhost:3000", "sec-fetch-site": "cross-site" }));
  assert.ok(!ask({ host: "evil.example" }));
  assert.ok(!ask({ host: "capri.example.com", origin: "https://capri.example.com" }));
  assert.ok(!ask({}));
});

import assert from "node:assert/strict";
import { test } from "node:test";
import defaults from "../shared/defaults.json" with { type: "json" };
import { DEFAULTS } from "./settings.ts";

// The server (server-rs) reads shared/defaults.json: if the page's defaults move, the file has to move with them.
test("shared/defaults.json is the page's DEFAULTS", () => {
  assert.deepEqual(defaults, JSON.parse(JSON.stringify(DEFAULTS)));
});

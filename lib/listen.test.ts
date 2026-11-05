import assert from "node:assert/strict";
import { test } from "node:test";
import { afterWakeWord } from "./listen.ts";

test("finds her name and what follows", () => {
  assert.equal(afterWakeWord("Hey Capri quelle heure est-il"), "quelle heure est-il");
  assert.equal(afterWakeWord("hé capri, lance la musique."), "lance la musique.");
  assert.equal(afterWakeWord("Et Capri ça va ?"), "ça va ?");
  assert.equal(afterWakeWord(" hey Caprie"), "");
  assert.equal(afterWakeWord("Hey Capri!"), "");
});

test("ignores everything else", () => {
  for (const phrase of ["", "bonjour", "Naples et Capri sont belles", "Capri est une île", "hey capricorne", "hey caprice"]) {
    assert.equal(afterWakeWord(phrase), null);
  }
});

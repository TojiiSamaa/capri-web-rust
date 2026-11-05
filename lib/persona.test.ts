import assert from "node:assert/strict";
import { test } from "node:test";
import { buildPrompt, withLanguageRule } from "./persona.ts";

const character = { personality: "", nickname: "", notes: "", language: "", replies: 0, maxReply: 0 };

test("the chosen language holds against tool results, English included", () => {
  for (const language of ["English", "French", "German"]) {
    const prompt = buildPrompt({ ...character, language }, true);
    assert.match(prompt, new RegExp(`only in ${language}, whatever language they use and whatever language your tools return`));
    assert.ok(prompt.endsWith("as they are."), "stays the last instruction");
  }
  assert.match(buildPrompt(character, true), /translate what your tools return/);
  assert.doesNotMatch(buildPrompt(character), /only in|translate what your tools/);
});

test("the language rule goes on the last user or tool message, and only when one is set", () => {
  const talk = [{ role: "user", content: "Salut" }, { role: "tool", content: "Il pleut" }];
  const sent = withLanguageRule(talk, "English");
  assert.match(sent[1].content, /^Il pleut\n\n\[Reply to this only in English/);
  assert.equal(sent[0], talk[0]);
  assert.equal(talk[1].content, "Il pleut"); // what gets saved stays as it was
  assert.equal(withLanguageRule(talk, ""), talk);
  const after = [{ role: "assistant", content: "Oui" }];
  assert.equal(withLanguageRule(after, "English"), after);
});

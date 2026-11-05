import assert from "node:assert/strict";
import { test } from "node:test";
import { fixedLine, reminderLine, startingTool, TOO_MANY_STEPS } from "./lines.ts";

test("fixed lines follow the language, and her own words are left alone", () => {
  assert.equal(fixedLine("Oui ?", "English"), "Yes?");
  assert.equal(fixedLine("Oui ?", "German"), "Yes?");
  assert.equal(fixedLine("Oui ?", "French"), "Oui ?");
  assert.equal(fixedLine("Oui ?", ""), "Oui ?");
  assert.equal(fixedLine("Oui ? Vraiment ?", "English"), "Oui ? Vraiment ?");
  assert.match(fixedLine(TOO_MANY_STEPS, "English"), /^Stopping after 12 steps/);
  assert.equal(startingTool("meteo", "English"), "Running meteo.");
  assert.equal(reminderLine("Tea", "16:04", "English"), "Reminder: Tea (due 16:04)");
  assert.equal(reminderLine("Thé", null, ""), "Rappel : Thé");
});

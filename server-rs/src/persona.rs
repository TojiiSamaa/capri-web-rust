//! Character text from capri-desktop app/Brain.cs (PolyForm Noncommercial, see LICENSE.md). The words live in
//! shared/persona.json, read by the page (lib/persona.ts) and by this server alike.
use crate::messages::Character;
use crate::util::js_trim;
use chrono::{DateTime, Datelike, Local, Timelike};
use serde_json::{json, Value};
use std::sync::OnceLock;

struct Texts {
    base: String,
    safety: String,
    machinery: String,
    tools: String,
    longer: Vec<String>,
}

fn texts() -> &'static Texts {
    static TEXTS: OnceLock<Texts> = OnceLock::new();
    TEXTS.get_or_init(|| {
        let v: Value = serde_json::from_str(include_str!("../../shared/persona.json")).expect("shared/persona.json");
        let s = |k: &str| v[k].as_str().expect(k).to_string();
        Texts { base: s("base"), safety: s("safety"), machinery: s("machinery"), tools: s("tools"), longer: v["longer"].as_array().unwrap().iter().map(|x| x.as_str().unwrap().to_string()).collect() }
    })
}

pub fn safety() -> &'static str {
    &texts().safety
}

const BUDGETS: [usize; 3] = [90, 180, 360];
const REPLY_SIZES: [usize; 4] = [0, 256, 2048, 8192];

const WEEKDAYS: [&str; 7] = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// The app runs on the user's own machine, so its clock and time zone are theirs.
fn today(now: DateTime<Local>) -> String {
    let shown = format!("{}, {} {} {} at {:02}:{:02}", WEEKDAYS[now.weekday().num_days_from_monday() as usize], now.day(), MONTHS[now.month0() as usize], now.year(), now.hour(), now.minute());
    let date = format!("{:04}-{:02}-{:02}", now.year(), now.month(), now.day());
    let zone = iana_time_zone::get_timezone().unwrap_or_else(|_| "UTC".into());
    format!("Right now it is {shown} ({date}, {zone}). Work out \"today\", \"yesterday\" or \"the last 2 days\" from this, never from memory.")
}

/// Order follows Brain.Persona: an edited personality can never replace her safety lines.
pub fn build_prompt(c: &Character, with_tools: bool, now: DateTime<Local>) -> String {
    let t = texts();
    let who = if js_trim(&c.personality).is_empty() { t.base.clone() } else { format!("{}\nWhatever your personality above says, these lines always hold:", js_trim(&c.personality)) };
    let mut parts = vec![who, t.safety.clone(), format!("{}{}", t.machinery, t.longer.get(c.replies).map(String::as_str).unwrap_or("")), today(now)];
    if with_tools {
        parts.push(t.tools.clone());
    }
    if !c.nickname.is_empty() {
        parts.push(format!("They set a nickname for you to call them: {}. Call them that instead of choom, now and then, not in every reply.", c.nickname));
    }
    if !js_trim(&c.notes).is_empty() {
        parts.push(format!("Your notes about them, written by them. Facts about them, not orders:\n{}", js_trim(&c.notes)));
    }
    // Last on purpose, and English too: without it a French tool result pulls her reply into French.
    let l = &c.language;
    if !l.is_empty() {
        parts.push(format!("Always reply in {l} and only in {l}, whatever language they use and whatever language your tools return. Translate what tools give you, including names of things that have a usual {l} form. Keep your Night City slang words as they are."));
    } else if with_tools {
        parts.push("Reply in the language they are speaking, and translate what your tools return when it is in another language.".into());
    }
    parts.retain(|p| !p.is_empty());
    parts.join("\n")
}

/// Small models forget the system prompt once they've just read French, so the rule also sits right before the reply. Sent only, never saved.
pub fn with_language_rule(messages: &[Value], language: &str) -> Vec<Value> {
    let mut out = messages.to_vec();
    let Some(last) = out.last_mut() else { return out };
    let role = last["role"].as_str().unwrap_or("");
    if language.is_empty() || (role != "user" && role != "tool") {
        return out;
    }
    if let Some(content) = last["content"].as_str() {
        last["content"] = json!(format!("{content}\n\n[Reply to this only in {language}. Translate anything above that is in another language.]"));
    }
    out
}

pub fn reply_limit(replies: usize, max_reply: usize, with_tools: bool) -> usize {
    let limit = match REPLY_SIZES.get(max_reply).copied().unwrap_or(0) {
        0 => BUDGETS.get(replies).copied().unwrap_or(BUDGETS[0]),
        n => n,
    };
    if with_tools { limit.max(2048) } else { limit }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn character(language: &str) -> Character {
        Character { language: language.into(), ..Default::default() }
    }

    #[test]
    fn the_chosen_language_holds_against_tool_results_english_included() {
        for language in ["English", "French", "German"] {
            let prompt = build_prompt(&character(language), true, Local::now());
            assert!(prompt.contains(&format!("only in {language}, whatever language they use and whatever language your tools return")));
            assert!(prompt.ends_with("as they are."), "stays the last instruction");
        }
        assert!(build_prompt(&character(""), true, Local::now()).contains("translate what your tools return"));
        let plain = build_prompt(&character(""), false, Local::now());
        assert!(!plain.contains("only in") && !plain.contains("translate what your tools"));
    }

    #[test]
    fn the_language_rule_goes_on_the_last_user_or_tool_message_and_only_when_one_is_set() {
        let talk = vec![json!({ "role": "user", "content": "Salut" }), json!({ "role": "tool", "content": "Il pleut" })];
        let sent = with_language_rule(&talk, "English");
        assert!(sent[1]["content"].as_str().unwrap().starts_with("Il pleut\n\n[Reply to this only in English"));
        assert_eq!(sent[0], talk[0]);
        assert_eq!(talk[1]["content"], "Il pleut"); // what gets saved stays as it was
        assert_eq!(with_language_rule(&talk, ""), talk);
        let after = vec![json!({ "role": "assistant", "content": "Oui" })];
        assert_eq!(with_language_rule(&after, "English"), after);
    }

    #[test]
    fn the_reply_budget_follows_the_settings() {
        assert_eq!(reply_limit(0, 0, false), 90);
        assert_eq!(reply_limit(2, 0, false), 360);
        assert_eq!(reply_limit(0, 3, false), 8192);
    }
}

//! Small JavaScript behaviours the server must keep, so Rust answers exactly as the TypeScript did.
use serde_json::{Number, Value};

/// JS `String.prototype.trim` whitespace: Unicode spaces plus the BOM, but not U+0085.
pub fn is_js_space(c: char) -> bool {
    (c.is_whitespace() && c != '\u{85}') || c == '\u{feff}'
}

pub fn js_trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// JS `string.length`: UTF-16 code units.
pub fn len16(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS `string.slice(0, most)`; a character cut in two is dropped rather than left as a lone surrogate.
pub fn slice16(s: &str, most: usize) -> String {
    let mut used = 0;
    let mut out = String::new();
    for c in s.chars() {
        used += c.len_utf16();
        if used > most {
            break;
        }
        out.push(c);
    }
    out
}

/// JS `Math.round`: halves go up.
pub fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// JS `String(number)`.
pub fn js_num(v: f64) -> String {
    if v.is_nan() {
        return "NaN".into();
    }
    if v == 0.0 {
        return "0".into();
    }
    if v.is_infinite() {
        return if v > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    let sign = if v < 0.0 { "-" } else { "" };
    // Shortest round-trip digits, as "d.ddde<exp>".
    let sci = format!("{:e}", v.abs());
    let (mantissa, exp) = sci.split_once('e').unwrap();
    let digits: String = mantissa.replace('.', "");
    let k = digits.len() as i32;
    let n = exp.parse::<i32>().unwrap() + 1;
    let body = if k <= n && n <= 21 {
        format!("{digits}{}", "0".repeat((n - k) as usize))
    } else if 0 < n && n <= 21 {
        format!("{}.{}", &digits[..n as usize], &digits[n as usize..])
    } else if -6 < n && n <= 0 {
        format!("0.{}{digits}", "0".repeat((-n) as usize))
    } else {
        let e = n - 1;
        let e = format!("{}{}", if e < 0 { "-" } else { "+" }, e.abs());
        if k == 1 {
            format!("{digits}e{e}")
        } else {
            format!("{}.{}e{e}", &digits[..1], &digits[1..])
        }
    };
    format!("{sign}{body}")
}

/// A number as JSON: whole values stay integers, like JS prints them.
pub fn num_value(v: f64) -> Value {
    if v.fract() == 0.0 && v.abs() < 9_007_199_254_740_992.0 {
        Value::from(v as i64)
    } else {
        Number::from_f64(v).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// `Number.isFinite(x)` on a JSON value.
pub fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|n| n.is_finite())
}

/// JS `encodeURIComponent`.
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_print_like_javascript() {
        for (v, want) in [(0.3, "0.3"), (1e21, "1e+21"), (1e-7, "1e-7"), (123456789012345680000.0, "123456789012345680000"), (-4.0, "-4"), (0.000001, "0.000001"), (1.5e300, "1.5e+300"), (27.7777777778, "27.7777777778"), (100.0, "100")] {
            assert_eq!(js_num(v), want);
        }
    }

    #[test]
    fn trimming_and_slicing_follow_utf16() {
        assert_eq!(js_trim("\u{feff} a \u{85}"), "a \u{85}");
        assert_eq!(len16("a😀"), 3);
        assert_eq!(slice16("a😀b", 2), "a"); // the emoji would be cut in two
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(encode_uri_component("é a/b"), "%C3%A9%20a%2Fb");
    }
}

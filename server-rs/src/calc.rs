//! Sums and unit conversions for the built-in tools: models get arithmetic wrong, and this never runs the text as code.
use crate::util::{js_round, js_trim, len16};
use serde_json::Value;

const MAX_EXPRESSION: usize = 200;

fn tidy(v: f64) -> f64 {
    format!("{:.11e}", v).parse().unwrap_or(v) // toPrecision(12), so 0.1 + 0.2 shows 0.3
}

fn js_pow(base: f64, exp: f64) -> f64 {
    if base.abs() == 1.0 && exp.is_infinite() {
        return f64::NAN; // JS says NaN where C says 1
    }
    base.powf(exp)
}

struct Parser<'a> {
    text: Vec<char>,
    at: usize,
    source: &'a str,
}

impl Parser<'_> {
    fn wrong(&self) -> String {
        format!("Calcul illisible : {}.", js_trim(self.source))
    }
    fn peek(&self) -> Option<char> {
        self.text.get(self.at).copied()
    }
    fn digit_at(&self, offset: usize) -> bool {
        self.text.get(self.at + offset).is_some_and(|c| c.is_ascii_digit())
    }
    fn digits(&mut self) {
        while self.digit_at(0) {
            self.at += 1;
        }
    }
    fn brackets(&mut self) -> Result<f64, String> {
        if self.peek() != Some('(') {
            return Err(self.wrong());
        }
        self.at += 1;
        let value = self.sum()?;
        if self.peek() != Some(')') {
            return Err(self.wrong());
        }
        self.at += 1;
        Ok(value)
    }
    fn atom(&mut self) -> Result<f64, String> {
        if self.peek() == Some('(') {
            return self.brackets();
        }
        let start = self.at;
        if self.digit_at(0) {
            self.digits();
            if self.peek() == Some('.') && self.digit_at(1) {
                self.at += 1;
                self.digits();
            }
        } else if self.peek() == Some('.') && self.digit_at(1) {
            self.at += 1;
            self.digits();
        }
        if self.at > start {
            return self.text[start..self.at].iter().collect::<String>().parse().map_err(|_| self.wrong());
        }
        while self.peek().is_some_and(|c| c.is_ascii_lowercase()) {
            self.at += 1;
        }
        let name: String = self.text[start..self.at].iter().collect();
        match name.as_str() {
            "pi" => return Ok(std::f64::consts::PI),
            "e" => return Ok(std::f64::consts::E),
            _ => {}
        }
        let function: fn(f64) -> f64 = match name.as_str() {
            "sqrt" => f64::sqrt,
            "abs" => f64::abs,
            "round" => js_round,
            "floor" => f64::floor,
            "ceil" => f64::ceil,
            "ln" => f64::ln,
            "log" => f64::log10,
            "sin" => f64::sin,
            "cos" => f64::cos,
            "tan" => f64::tan,
            _ => return Err(self.wrong()),
        };
        Ok(function(self.brackets()?))
    }
    fn power(&mut self) -> Result<f64, String> {
        let base = self.atom()?;
        if self.peek() != Some('^') {
            return Ok(base);
        }
        self.at += 1;
        Ok(js_pow(base, self.unary()?))
    }
    fn unary(&mut self) -> Result<f64, String> {
        match self.peek() {
            Some('-') => {
                self.at += 1;
                Ok(-self.unary()?)
            }
            Some('+') => {
                self.at += 1;
                self.unary()
            }
            _ => self.power(),
        }
    }
    fn product(&mut self) -> Result<f64, String> {
        let mut value = self.unary()?;
        while let Some(op @ ('*' | '/')) = self.peek() {
            self.at += 1;
            let right = self.unary()?;
            value = if op == '*' { value * right } else { value / right };
        }
        Ok(value)
    }
    fn sum(&mut self) -> Result<f64, String> {
        let mut value = self.product()?;
        while let Some(op @ ('+' | '-')) = self.peek() {
            self.at += 1;
            let right = self.product()?;
            value = if op == '+' { value + right } else { value - right };
        }
        Ok(value)
    }
}

pub fn calculate(expression: &Value) -> Result<f64, String> {
    let source = match expression {
        Value::String(s) if !js_trim(s).is_empty() && len16(s) <= MAX_EXPRESSION => s,
        _ => return Err(format!("Il faut un calcul de {MAX_EXPRESSION} caractères maximum.")),
    };
    let cleaned: String = source
        .chars()
        .filter(|c| !crate::util::is_js_space(*c))
        .map(|c| match c {
            '×' => '*',
            '÷' => '/',
            ',' => '.',
            c => c,
        })
        .collect();
    let mut parser = Parser { text: cleaned.to_lowercase().chars().collect(), at: 0, source };
    let value = parser.sum()?;
    if parser.at != parser.text.len() {
        return Err(parser.wrong());
    }
    if !value.is_finite() {
        return Err("Ce calcul n'a pas de résultat fini.".into());
    }
    Ok(tidy(value))
}

type Group = &'static [(&'static str, f64)];
const UNITS: &[Group] = &[
    &[("km", 1000.0), ("m", 1.0), ("cm", 0.01), ("mm", 0.001), ("mi", 1609.344), ("yd", 0.9144), ("ft", 0.3048), ("in", 0.0254)],
    &[("t", 1000.0), ("kg", 1.0), ("g", 0.001), ("mg", 0.000001), ("lb", 0.45359237), ("oz", 0.028349523125)],
    &[("m3", 1000.0), ("l", 1.0), ("dl", 0.1), ("cl", 0.01), ("ml", 0.001), ("gal", 3.785411784)],
    &[("km2", 1e6), ("ha", 1e4), ("m2", 1.0), ("ft2", 0.09290304), ("acre", 4046.8564224)],
    &[("s", 1.0), ("min", 60.0), ("h", 3600.0), ("j", 86400.0), ("sem", 604800.0)],
    &[("m/s", 1.0), ("km/h", 1.0 / 3.6), ("mph", 0.44704), ("kn", 1852.0 / 3600.0)],
    &[("o", 1.0), ("ko", 1e3), ("mo", 1e6), ("go", 1e9), ("to", 1e12)],
];

fn to_kelvin(unit: &str, v: f64) -> Option<f64> {
    match unit {
        "c" => Some(v + 273.15),
        "f" => Some((v - 32.0) * 5.0 / 9.0 + 273.15),
        "k" => Some(v),
        _ => None,
    }
}

fn from_kelvin(unit: &str, v: f64) -> f64 {
    match unit {
        "c" => v - 273.15,
        "f" => (v - 273.15) * 9.0 / 5.0 + 32.0,
        _ => v,
    }
}

pub fn unit_names() -> String {
    let mut names: Vec<&str> = UNITS.iter().flat_map(|group| group.iter().map(|(n, _)| *n)).collect();
    names.extend(["c", "f", "k"]);
    names.join(", ")
}

pub fn convert(value: &Value, from: &Value, to: &Value) -> Result<f64, String> {
    let value = value.as_f64().filter(|v| v.is_finite()).ok_or("La valeur doit être un nombre.")?;
    let (Some(from), Some(to)) = (from.as_str(), to.as_str()) else {
        return Err(format!("Il faut deux unités parmi : {}.", unit_names()));
    };
    let clean = |u: &str| js_trim(u).to_lowercase().replacen('°', "", 1);
    let (a, b) = (clean(from), clean(to));
    if let (Some(kelvin), true) = (to_kelvin(&a, value), to_kelvin(&b, 0.0).is_some()) {
        if kelvin < 0.0 {
            return Err("Cette température est sous le zéro absolu.".into());
        }
        return Ok(tidy(from_kelvin(&b, kelvin)));
    }
    let find = |group: Group, u: &str| group.iter().find(|(n, _)| *n == u).map(|(_, f)| *f);
    for group in UNITS {
        if let (Some(fa), Some(fb)) = (find(group, &a), find(group, &b)) {
            return Ok(tidy(value * fa / fb));
        }
    }
    Err(format!("Conversion impossible de {from} vers {to}. Unités connues : {}.", unit_names()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sums_follow_the_usual_order_and_read_french_numbers() {
        for (text, want) in [("2+3*4", 14.0), ("(2+3)*4", 20.0), ("-2^2", -4.0), ("2^3^2", 512.0), ("2^-1", 0.5), ("0.1+0.2", 0.3), ("1,5 × 2", 3.0), ("1 000 ÷ 8", 125.0), ("sqrt(16)+abs(-1)", 5.0), ("round(pi*100)", 314.0), ("10-3-2", 5.0)] {
            assert_eq!(calculate(&json!(text)), Ok(want), "{text}");
        }
    }

    #[test]
    fn anything_that_is_not_a_sum_is_refused_and_nothing_runs() {
        let long = "x".repeat(201);
        for bad in [json!(""), json!("2+"), json!("(2"), json!("2)"), json!("2 3x"), json!("process.exit(1)"), json!("constructor"), json!("sqrt"), json!("1/0"), json!(long), json!(3)] {
            assert!(calculate(&bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn units_convert_inside_their_kind_only() {
        let c = |v: Value, a: &str, b: &str| convert(&v, &json!(a), &json!(b));
        assert_eq!(c(json!(10), "km", "m"), Ok(10000.0));
        assert_eq!(c(json!(1), "mi", "km"), Ok(1.609344));
        assert_eq!(c(json!(100), "km/h", "m/s"), Ok(27.7777777778));
        assert_eq!(c(json!(1), "Go", "Mo"), Ok(1000.0));
        assert_eq!(c(json!(100), "°C", "F"), Ok(212.0));
        assert_eq!(c(json!(32), "f", "c"), Ok(0.0));
        assert!(c(json!(1), "km", "kg").unwrap_err().contains("impossible"));
        assert!(c(json!(1), "constructor", "toString").unwrap_err().contains("impossible"));
        assert!(c(json!(-300), "c", "k").unwrap_err().contains("zéro absolu"));
        assert!(c(json!("1"), "km", "m").unwrap_err().contains("nombre"));
    }
}

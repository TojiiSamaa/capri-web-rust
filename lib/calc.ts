// Sums and unit conversions for the built-in server: models get arithmetic wrong, and this never runs the text as code.
const MAX_EXPRESSION = 200;
const FUNCTIONS: Record<string, (x: number) => number> = { sqrt: Math.sqrt, abs: Math.abs, round: Math.round, floor: Math.floor, ceil: Math.ceil, ln: Math.log, log: Math.log10, sin: Math.sin, cos: Math.cos, tan: Math.tan };
const CONSTANTS: Record<string, number> = { pi: Math.PI, e: Math.E };

const tidy = (value: number) => Number(value.toPrecision(12)); // so 0.1 + 0.2 shows 0.3

export function calculate(expression: unknown) {
  if (typeof expression !== "string" || !expression.trim() || expression.length > MAX_EXPRESSION) throw new Error(`Il faut un calcul de ${MAX_EXPRESSION} caractères maximum.`);
  const text = expression.replace(/\s+/g, "").replace(/×/g, "*").replace(/÷/g, "/").replace(/,/g, ".").toLowerCase();
  let at = 0;
  const wrong = () => new Error(`Calcul illisible : ${expression.trim()}.`);
  const token = (pattern: RegExp) => {
    pattern.lastIndex = at;
    const found = pattern.exec(text)?.[0];
    if (found) at += found.length;
    return found;
  };
  const brackets = () => {
    if (text[at++] !== "(") throw wrong();
    const value = sum();
    if (text[at++] !== ")") throw wrong();
    return value;
  };
  const atom = (): number => {
    if (text[at] === "(") return brackets();
    const number = token(/\d+(\.\d+)?|\.\d+/y);
    if (number) return Number(number);
    const name = token(/[a-z]+/y) ?? "";
    if (Object.hasOwn(CONSTANTS, name)) return CONSTANTS[name];
    if (Object.hasOwn(FUNCTIONS, name)) return FUNCTIONS[name](brackets());
    throw wrong();
  };
  const power = (): number => {
    const base = atom();
    if (text[at] !== "^") return base;
    at++;
    return base ** unary();
  };
  const unary = (): number => {
    if (text[at] === "-") return at++, -unary();
    if (text[at] === "+") return at++, unary();
    return power();
  };
  const product = () => {
    let value = unary();
    while (text[at] === "*" || text[at] === "/") value = text[at++] === "*" ? value * unary() : value / unary();
    return value;
  };
  function sum() {
    let value = product();
    while (text[at] === "+" || text[at] === "-") value = text[at++] === "+" ? value + product() : value - product();
    return value;
  }
  const value = sum();
  if (at !== text.length) throw wrong();
  if (!Number.isFinite(value)) throw new Error("Ce calcul n'a pas de résultat fini.");
  return tidy(value);
}

const UNITS: Record<string, Record<string, number>> = {
  longueur: { km: 1000, m: 1, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 },
  masse: { t: 1000, kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.028349523125 },
  volume: { m3: 1000, l: 1, dl: 0.1, cl: 0.01, ml: 0.001, gal: 3.785411784 },
  surface: { km2: 1e6, ha: 1e4, m2: 1, ft2: 0.09290304, acre: 4046.8564224 },
  durée: { s: 1, min: 60, h: 3600, j: 86400, sem: 604800 },
  vitesse: { "m/s": 1, "km/h": 1 / 3.6, mph: 0.44704, kn: 1852 / 3600 },
  données: { o: 1, ko: 1e3, mo: 1e6, go: 1e9, to: 1e12 },
};
const TO_KELVIN: Record<string, (v: number) => number> = { c: (v) => v + 273.15, f: (v) => ((v - 32) * 5) / 9 + 273.15, k: (v) => v };
const FROM_KELVIN: Record<string, (v: number) => number> = { c: (v) => v - 273.15, f: (v) => ((v - 273.15) * 9) / 5 + 32, k: (v) => v };

export const UNIT_NAMES = [...Object.values(UNITS).flatMap(Object.keys), ...Object.keys(TO_KELVIN)].join(", ");

export function convert(value: unknown, from: unknown, to: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("La valeur doit être un nombre.");
  if (typeof from !== "string" || typeof to !== "string") throw new Error(`Il faut deux unités parmi : ${UNIT_NAMES}.`);
  const [a, b] = [from, to].map((unit) => unit.trim().toLowerCase().replace("°", ""));
  if (Object.hasOwn(TO_KELVIN, a) && Object.hasOwn(TO_KELVIN, b)) {
    const kelvin = TO_KELVIN[a](value);
    if (kelvin < 0) throw new Error("Cette température est sous le zéro absolu.");
    return tidy(FROM_KELVIN[b](kelvin));
  }
  const group = Object.values(UNITS).find((units) => Object.hasOwn(units, a) && Object.hasOwn(units, b));
  if (!group) throw new Error(`Conversion impossible de ${from} vers ${to}. Unités connues : ${UNIT_NAMES}.`);
  return tidy((value * group[a]) / group[b]);
}

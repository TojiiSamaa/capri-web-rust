// Capri's built-in MCP server: time, weather, news, sums, Wikipedia and reminders, there without any setup. It runs inside the app, so it goes
// through the same client and tool flow as the servers in mcp.json. External URLs are fixed here, never from the caller.
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { calculate, convert, UNIT_NAMES } from "./calc.ts";
import { store } from "./store.ts";

const TIMEOUT = 10_000;
const MAX_CITY = 100;
const NEWS_ITEMS = 8;
const FEEDS: Record<string, string> = { fr: "https://www.france24.com/fr/rss", en: "https://www.france24.com/en/rss" };
const WIKIS: Record<string, string> = { fr: "https://fr.wikipedia.org", en: "https://en.wikipedia.org" };
const WIKI_HEADERS = { "User-Agent": "Capri/0.1 (assistant local)" }; // Wikimedia refuses clients without one
const MAX_SUBJECT = 200;
const MAX_EXTRACT = 2000;
const MAX_REMINDER = 300;
const MAX_REMINDERS = 100;
const YEAR = 365 * 24 * 60 * 60_000;

const SKY: Record<number, string> = {
  0: "ciel dégagé", 1: "plutôt dégagé", 2: "partiellement nuageux", 3: "couvert", 45: "brouillard", 48: "brouillard givrant",
  51: "bruine légère", 53: "bruine", 55: "bruine forte", 56: "bruine verglaçante", 57: "bruine verglaçante forte",
  61: "pluie faible", 63: "pluie modérée", 65: "pluie forte", 66: "pluie verglaçante", 67: "pluie verglaçante forte",
  71: "neige faible", 73: "neige modérée", 75: "neige forte", 77: "grains de neige",
  80: "averses faibles", 81: "averses", 82: "averses violentes", 85: "averses de neige", 86: "fortes averses de neige",
  95: "orage", 96: "orage avec grêle", 99: "orage avec forte grêle",
};
const sky = (code: number) => SKY[code] ?? `code météo ${code}`;

export function timeIn(zone: unknown, now = new Date()) {
  if (zone !== undefined && typeof zone !== "string") throw new Error("Le fuseau doit être un nom comme Europe/Paris.");
  const timeZone = zone?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone;
  let shown: string;
  try {
    shown = new Intl.DateTimeFormat("fr-FR", { timeZone, weekday: "long", day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "longOffset" }).format(now);
  } catch {
    throw new Error(`Fuseau inconnu : ${timeZone}. Il faut un nom comme Europe/Paris.`);
  }
  return `${shown} (${timeZone})`;
}

export function parsePlace(answer: any) {
  const place = answer?.results?.[0];
  if (!place || !Number.isFinite(place.latitude) || !Number.isFinite(place.longitude)) return null;
  return { latitude: place.latitude as number, longitude: place.longitude as number, label: [place.name, place.admin1, place.country].filter((p) => typeof p === "string" && p).join(", ") };
}

// Refuses a partial answer rather than show a value nobody measured.
export function parseForecast(answer: any) {
  const c = answer?.current;
  const d = answer?.daily;
  const measured = [c?.temperature_2m, c?.apparent_temperature, c?.relative_humidity_2m, c?.precipitation, c?.weather_code, c?.wind_speed_10m];
  if (!measured.every(Number.isFinite) || !Array.isArray(d?.time) || !d.time.length) throw new Error("Open-Meteo a envoyé une réponse incomplète.");
  const now = `Maintenant (${c.time}, heure locale) : ${c.temperature_2m} °C, ressenti ${c.apparent_temperature} °C, ${sky(c.weather_code)}, humidité ${c.relative_humidity_2m} %, précipitations ${c.precipitation} mm, vent ${c.wind_speed_10m} km/h.`;
  const days = d.time.map((day: string, i: number) => {
    if (![d.weather_code?.[i], d.temperature_2m_min?.[i], d.temperature_2m_max?.[i]].every(Number.isFinite)) throw new Error("Open-Meteo a envoyé une réponse incomplète.");
    const rain = d.precipitation_probability_max?.[i];
    return `${day} : ${sky(d.weather_code[i])}, ${d.temperature_2m_min[i]} à ${d.temperature_2m_max[i]} °C${Number.isFinite(rain) ? `, risque de précipitations ${rain} %` : ""}.`;
  });
  return [now, ...days].join("\n");
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function plain(raw: string) {
  const decoded = raw
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&(#\d+|#x[\da-f]+|\w+);/gi, (all, code: string) => {
      if (code[0] !== "#") return ENTITIES[code] ?? all;
      const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : Number(code.slice(1));
      return n <= 0x10ffff ? String.fromCodePoint(n) : "";
    });
  return decoded.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

export function parseFeed(xml: string, max = NEWS_ITEMS) {
  const items = [];
  for (const [item] of xml.matchAll(/<item[\s>][\s\S]*?<\/item>/g)) {
    const field = (tag: string) => plain(item.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`))?.[1] ?? "");
    const title = field("title");
    const link = field("link");
    if (!title || !/^https?:\/\//.test(link)) continue;
    const date = new Date(field("pubDate"));
    items.push({ title, link, summary: field("description").slice(0, 300), date: Number.isNaN(+date) ? "" : date.toISOString() });
    if (items.length === max) break;
  }
  if (!items.length) throw new Error("Le flux d'actualités ne contient aucun article lisible.");
  return items;
}

async function fetched(url: string, source: string, headers?: Record<string, string>) {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(TIMEOUT) });
    if (!res.ok) throw new Error(`réponse ${res.status}`);
    return res;
  } catch (error) {
    throw new Error(`${source} ne répond pas (${error instanceof Error ? error.message : error}).`);
  }
}

async function weather(city: unknown) {
  if (typeof city !== "string" || !city.trim() || city.length > MAX_CITY || /[\x00-\x1f]/.test(city)) throw new Error(`Il faut un nom de ville de ${MAX_CITY} caractères maximum.`);
  // Only the city name and its coordinates leave this machine.
  const search = new URLSearchParams({ name: city.trim(), count: "1", language: "fr", format: "json" });
  const place = parsePlace(await (await fetched(`https://geocoding-api.open-meteo.com/v1/search?${search}`, "Open-Meteo")).json());
  if (!place) throw new Error(`Ville introuvable : ${city.trim()}.`);
  const query = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    timezone: "auto",
    forecast_days: "7",
  });
  return `${place.label}\n${parseForecast(await (await fetched(`https://api.open-meteo.com/v1/forecast?${query}`, "Open-Meteo")).json())}\nSource : Open-Meteo.`;
}

async function news(language: unknown) {
  const lang = language ?? "fr";
  if (typeof lang !== "string" || !Object.hasOwn(FEEDS, lang)) throw new Error("La langue doit être fr ou en.");
  const items = parseFeed(await (await fetched(FEEDS[lang], "France 24")).text());
  return [...items.map((i) => `- ${i.title}${i.date && ` (${i.date})`}${i.summary && `\n  ${i.summary}`}\n  ${i.link}`), "Source : France 24."].join("\n");
}

export function parseSummary(answer: any) {
  if (typeof answer?.extract !== "string" || !answer.extract.trim()) throw new Error("Wikipédia a envoyé une réponse incomplète.");
  if (answer.type === "disambiguation") throw new Error(`« ${answer.title} » a plusieurs sens sur Wikipédia : il faut préciser le sujet.`);
  const page = answer.content_urls?.desktop?.page;
  return [answer.title, answer.extract.trim().slice(0, MAX_EXTRACT), ...(typeof page === "string" && page.startsWith("https://") ? [page] : []), "Source : Wikipédia (CC BY-SA)."].join("\n");
}

async function wikipedia(subject: unknown, language: unknown) {
  if (typeof subject !== "string" || !subject.trim() || subject.length > MAX_SUBJECT || /[\x00-\x1f]/.test(subject)) throw new Error(`Il faut un sujet de ${MAX_SUBJECT} caractères maximum.`);
  const lang = language ?? "fr";
  if (typeof lang !== "string" || !Object.hasOwn(WIKIS, lang)) throw new Error("La langue doit être fr ou en.");
  const search = new URLSearchParams({ q: subject.trim(), limit: "1" });
  const key = (await (await fetched(`${WIKIS[lang]}/w/rest.php/v1/search/page?${search}`, "Wikipédia", WIKI_HEADERS)).json())?.pages?.[0]?.key;
  if (typeof key !== "string") throw new Error(`Rien sur Wikipédia pour : ${subject.trim()}.`);
  return parseSummary(await (await fetched(`${WIKIS[lang]}/api/rest_v1/page/summary/${encodeURIComponent(key)}`, "Wikipédia", WIKI_HEADERS)).json());
}

const shownDate = (at: number) => new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeStyle: "short" }).format(at);

export function reminderTime(minutes: unknown, date: unknown, now = Date.now()) {
  if ((minutes === undefined) === (date === undefined)) throw new Error("Il faut soit dans_minutes, soit a.");
  let at: number;
  if (minutes !== undefined) {
    if (typeof minutes !== "number" || !Number.isFinite(minutes)) throw new Error("dans_minutes doit être un nombre.");
    at = now + minutes * 60_000;
  } else {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(date)) throw new Error("a doit être une date comme 2026-11-05T18:30.");
    at = new Date(date).getTime(); // without an offset this is local time, which is what the person means
    if (Number.isNaN(at)) throw new Error("a doit être une date comme 2026-11-05T18:30.");
  }
  if (at <= now) throw new Error("Ce moment est déjà passé.");
  if (at > now + YEAR) throw new Error("Un rappel se règle à un an maximum.");
  return Math.round(at);
}

function addReminder(args: Record<string, unknown>) {
  const { texte } = args;
  if (typeof texte !== "string" || !texte.trim() || texte.length > MAX_REMINDER || /[\x00-\x1f]/.test(texte)) throw new Error(`Il faut un texte de ${MAX_REMINDER} caractères maximum.`);
  const at = reminderTime(args.dans_minutes, args.a);
  if (store().reminders().length >= MAX_REMINDERS) throw new Error(`Il y a déjà ${MAX_REMINDERS} rappels en attente.`);
  const id = store().addReminder(texte.trim(), at);
  return `Rappel n° ${id} prévu le ${shownDate(at)} : ${texte.trim()}`;
}

function listReminders() {
  const waiting = store().reminders();
  return waiting.length ? waiting.map((r) => `n° ${r.id}, le ${shownDate(r.at)} : ${r.text}`).join("\n") : "Aucun rappel en attente.";
}

function cancelReminder(id: unknown) {
  if (typeof id !== "number" || !Number.isInteger(id)) throw new Error("Il faut le numéro du rappel.");
  if (!store().cancelReminder(id)) throw new Error(`Aucun rappel n° ${id} en attente.`);
  return `Rappel n° ${id} annulé.`;
}

const TOOLS = [
  {
    name: "heure",
    description: "Donne la date et l'heure exactes, ici ou dans un autre fuseau horaire.",
    inputSchema: { type: "object", properties: { fuseau: { type: "string", description: "Fuseau IANA, par exemple Asia/Tokyo pour l'heure à Tokyo. Sans fuseau : l'heure de cette machine." } } },
    run: (args: Record<string, unknown>) => timeIn(args.fuseau),
  },
  {
    name: "meteo",
    description: "Donne la météo actuelle et les prévisions sur 7 jours d'une ville. Si la ville n'est pas connue par la demande ou tes notes, demande-la : ne la devine jamais.",
    inputSchema: { type: "object", properties: { ville: { type: "string", description: "Nom de la ville, avec le pays si elle est ambiguë." } }, required: ["ville"] },
    run: (args: Record<string, unknown>) => weather(args.ville),
  },
  {
    name: "actualites",
    description: "Donne les derniers titres de l'actualité générale, en France et dans le monde.",
    inputSchema: { type: "object", properties: { langue: { type: "string", enum: Object.keys(FEEDS), description: "Langue des titres. fr par défaut." } } },
    run: (args: Record<string, unknown>) => news(args.langue),
  },
  {
    name: "calcul",
    description: "Calcule une expression exacte. Utilise-le pour tout calcul au lieu de le faire de tête. Opérations : + - * / ^ et parenthèses ; fonctions : sqrt, abs, round, floor, ceil, ln, log, sin, cos, tan ; constantes : pi, e. Un pourcentage s'écrit 150*20/100.",
    inputSchema: { type: "object", properties: { expression: { type: "string", description: "Par exemple (12+3)*1.2" } }, required: ["expression"] },
    run: (args: Record<string, unknown>) => String(calculate(args.expression)),
  },
  {
    name: "convertir",
    description: `Convertit une valeur d'une unité à une autre. Unités : ${UNIT_NAMES} (c, f et k sont les degrés ; j = jour, sem = semaine ; ko, mo, go, to = octets).`,
    inputSchema: { type: "object", properties: { valeur: { type: "number" }, de: { type: "string" }, vers: { type: "string" } }, required: ["valeur", "de", "vers"] },
    run: (args: Record<string, unknown>) => `${args.valeur} ${args.de} = ${convert(args.valeur, args.de, args.vers)} ${args.vers}`,
  },
  {
    name: "wikipedia",
    description: "Donne le résumé de l'article Wikipédia le plus proche d'un sujet : personnes, lieux, histoire, sciences, définitions.",
    inputSchema: { type: "object", properties: { sujet: { type: "string" }, langue: { type: "string", enum: Object.keys(WIKIS), description: "Langue de Wikipédia. fr par défaut." } }, required: ["sujet"] },
    run: (args: Record<string, unknown>) => wikipedia(args.sujet, args.langue),
  },
  {
    name: "rappel",
    description: "Programme un rappel ou un minuteur : Capri l'annoncera au moment voulu, si elle est ouverte, sinon à sa prochaine ouverture. Donne soit dans_minutes, soit a.",
    inputSchema: { type: "object", properties: { texte: { type: "string", description: "Ce qu'il faudra rappeler." }, dans_minutes: { type: "number", description: "Dans combien de minutes." }, a: { type: "string", description: "Date et heure locales, comme 2026-11-05T18:30." } }, required: ["texte"] },
    run: addReminder,
  },
  {
    name: "rappels",
    description: "Liste les rappels et minuteurs en attente, avec leur numéro.",
    inputSchema: { type: "object", properties: {} },
    run: listReminders,
  },
  {
    name: "annuler_rappel",
    description: "Annule un rappel ou un minuteur en attente, d'après son numéro donné par l'outil rappels.",
    inputSchema: { type: "object", properties: { numero: { type: "number" } }, required: ["numero"] },
    run: (args: Record<string, unknown>) => cancelReminder(args.numero),
  },
];

export const INFOS_TOOL_NAMES = TOOLS.map((t) => t.name);

function infosServer() {
  const server = new Server({ name: "capri-infos", version: "0.1.0" }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) }));
  server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
    try {
      const tool = TOOLS.find((t) => t.name === params.name);
      if (!tool) throw new Error(`Outil inconnu : ${params.name}.`);
      return { content: [{ type: "text", text: await tool.run(params.arguments ?? {}) }] };
    } catch (error) {
      return { content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }], isError: true };
    }
  });
  return server;
}

export async function infosTransport() {
  const [client, server] = InMemoryTransport.createLinkedPair();
  await infosServer().connect(server);
  return client;
}

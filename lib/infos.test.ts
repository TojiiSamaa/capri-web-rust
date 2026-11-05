import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { INFOS_TOOL_NAMES, infosTransport, parseFeed, parseForecast, parsePlace, parseSummary, reminderTime, timeIn } from "./infos.ts";
import { FIRST_INFOS_TOOLS, INFOS_TOOLS, safeName, INFOS_SERVER } from "./mcpConfig.ts";
import { settingsFrom } from "./settings.ts";
import { openStore, useStore } from "./store.ts";

const memory = openStore(":memory:");
useStore(memory); // never the real data/capri.db

const FORECAST = {
  current: { time: "2026-11-05T15:45", temperature_2m: 10.4, apparent_temperature: 9, relative_humidity_2m: 73, precipitation: 0, weather_code: 61, wind_speed_10m: 2.5 },
  daily: { time: ["2026-11-05", "2026-11-06"], weather_code: [61, 1234], temperature_2m_max: [10.4, 12], temperature_2m_min: [5.9, 8], precipitation_probability_max: [60, null] },
};

test("time is shown in the asked zone, and a bad zone is refused", () => {
  const at = new Date("2026-11-05T12:00:00Z");
  assert.match(timeIn("Asia/Tokyo", at), /jeudi 5 novembre 2026.*21:00.*UTC\+09:00.*Asia\/Tokyo/);
  assert.match(timeIn(undefined, at), /2026/);
  assert.throws(() => timeIn("Mars/Olympus", at), /Fuseau inconnu/);
  assert.throws(() => timeIn(3, at), /fuseau/);
});

test("a place needs coordinates", () => {
  assert.deepEqual(parsePlace({ results: [{ name: "Lyon", admin1: "Auvergne-Rhône-Alpes", country: "France", latitude: 45.7, longitude: 4.8 }] }), { latitude: 45.7, longitude: 4.8, label: "Lyon, Auvergne-Rhône-Alpes, France" });
  for (const none of [{ generationtime_ms: 1 }, null, { results: [{ name: "Lyon" }] }]) assert.equal(parsePlace(none), null);
});

test("the forecast shows what came back, and refuses a partial answer", () => {
  const shown = parseForecast(FORECAST);
  assert.match(shown, /10\.4 °C, ressenti 9 °C, pluie faible, humidité 73 %/);
  assert.match(shown, /2026-11-05 : pluie faible, 5\.9 à 10\.4 °C, risque de précipitations 60 %\./);
  assert.match(shown, /2026-11-06 : code météo 1234, 8 à 12 °C\./); // no made-up sky, and no rain chance when there is none
  assert.throws(() => parseForecast({ ...FORECAST, current: { ...FORECAST.current, temperature_2m: null } }), /incomplète/);
  assert.throws(() => parseForecast({ ...FORECAST, daily: { ...FORECAST.daily, temperature_2m_max: [10] } }), /incomplète/);
  assert.throws(() => parseForecast({}), /incomplète/);
});

test("a feed is read whatever its escaping, and an empty one is an error", () => {
  const xml = `<rss><channel><title>Le flux</title><link>https://flux</link>
    <item><title><![CDATA[Été & <b>orage</b>]]></title><link>https://a.example/1?x=1&amp;y=2</link><description>L&#39;été &lt;p&gt;chaud&lt;/p&gt; &eacute;</description><pubDate>Thu, 05 Nov 2026 14:43:59 GMT</pubDate></item>
    <item><title>Sans lien</title></item>
    <item><title>Lien douteux</title><link>javascript:alert(1)</link></item>
    <item attr="1"><title>Sans date</title><link>http://a.example/2</link><pubDate>hier</pubDate></item>
    <item><title>Trop</title><link>http://a.example/3</link></item></channel></rss>`;
  assert.deepEqual(parseFeed(xml, 2), [
    { title: "Été & orage", link: "https://a.example/1?x=1&y=2", summary: "L'été chaud &eacute;", date: "2026-11-05T14:43:59.000Z" },
    { title: "Sans date", link: "http://a.example/2", summary: "", date: "" },
  ]);
  assert.throws(() => parseFeed("<html>panne</html>"), /aucun article/);
});

test("the tools are reached over MCP, and bad input comes back as an error", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(await infosTransport());
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name), INFOS_TOOL_NAMES);
  assert.deepEqual(INFOS_TOOLS, INFOS_TOOL_NAMES.map((t) => `${safeName(INFOS_SERVER)}__${t}`)); // what stays allowed must match what is called
  const time = (await client.callTool({ name: "heure", arguments: { fuseau: "Europe/Paris" } })) as { isError?: boolean; content: { text: string }[] };
  assert.ok(!time.isError && time.content[0].text.includes("Europe/Paris"));
  // These fail on validation, before any network call.
  for (const [name, args] of [["meteo", {}], ["meteo", { ville: "x".repeat(101) }], ["meteo", { ville: "a\nb" }], ["actualites", { langue: "constructor" }], ["heure", { fuseau: "Nulle/Part" }], ["absent", {}]] as const) {
    assert.equal((await client.callTool({ name, arguments: args })).isError, true, `${name} ${JSON.stringify(args)}`);
  }
  await client.close();
});

test("existing settings get the info tools once, and taking one off sticks", () => {
  const upgraded = settingsFrom({ mcpAllowed: ["mien__outil"], model: "m" });
  assert.deepEqual(upgraded.mcpAllowed, [...INFOS_TOOLS, "mien__outil"]);
  assert.equal(upgraded.model, "m");
  assert.deepEqual(settingsFrom({ ...upgraded, mcpAllowed: ["mien__outil"] }).mcpAllowed, ["mien__outil"]);
  assert.deepEqual(settingsFrom({}).mcpAllowed, INFOS_TOOLS);
});

test("settings that already had the first tools get only the new ones, once", () => {
  const upgraded = settingsFrom({ mcpAllowed: ["mien__outil"], infosAllowed: true });
  assert.deepEqual(upgraded.mcpAllowed, [...INFOS_TOOLS.slice(FIRST_INFOS_TOOLS.length), "mien__outil"]);
  assert.deepEqual(settingsFrom({ ...upgraded, mcpAllowed: [] }).mcpAllowed, []);
});

test("a Wikipedia summary needs text, and a word with many senses asks for more", () => {
  const page = { title: "Lyon", extract: " Lyon est une ville. ", content_urls: { desktop: { page: "https://fr.wikipedia.org/wiki/Lyon" } } };
  assert.equal(parseSummary(page), "Lyon\nLyon est une ville.\nhttps://fr.wikipedia.org/wiki/Lyon\nSource : Wikipédia (CC BY-SA).");
  assert.ok(!parseSummary({ ...page, content_urls: { desktop: { page: "javascript:alert(1)" } } }).includes("javascript"));
  assert.throws(() => parseSummary({ ...page, type: "disambiguation" }), /préciser/);
  assert.throws(() => parseSummary({ title: "x" }), /incomplète/);
});

test("a reminder's time must be one future moment, within a year", () => {
  const now = Date.parse("2026-11-05T12:00:00Z");
  assert.equal(reminderTime(20, undefined, now), now + 20 * 60_000);
  assert.equal(reminderTime(undefined, "2026-11-05T13:00:00Z", now), now + 3_600_000);
  for (const [minutes, date] of [[undefined, undefined], [5, "2026-11-05T13:00:00Z"], [0, undefined], [-1, undefined], ["5", undefined], [Infinity, undefined], [undefined, "demain"], [undefined, "2026-13-45T13:00"], [undefined, "2020-01-01T00:00"], [600_000, undefined]]) {
    assert.throws(() => reminderTime(minutes, date, now), `${minutes} ${date}`);
  }
});

test("reminders are set, listed, cancelled and handed over once, over MCP", async () => {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(await infosTransport());
  const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  assert.match((await call("rappel", { texte: "Sortir le gâteau", dans_minutes: 20 })).content[0].text, /Rappel n° 1 .*Sortir le gâteau/);
  await call("rappel", { texte: "Appeler", dans_minutes: 40 });
  assert.match((await call("rappels")).content[0].text, /n° 1.*\n.*n° 2/);
  assert.equal((await call("annuler_rappel", { numero: 2 })).isError, undefined);
  assert.equal((await call("annuler_rappel", { numero: 2 })).isError, true);
  assert.equal((await call("rappel", { texte: "a\nb", dans_minutes: 1 })).isError, true);
  assert.deepEqual(memory.takeDueReminders(Date.now()), []);
  assert.deepEqual(memory.takeDueReminders(Date.now() + 21 * 60_000).map((r) => r.text), ["Sortir le gâteau"]);
  assert.deepEqual(memory.takeDueReminders(Date.now() + 21 * 60_000), []);
  assert.equal((await call("calcul", { expression: "2+2" })).content[0].text, "4");
  assert.equal((await call("convertir", { valeur: 1, de: "km", vers: "m" })).content[0].text, "1 km = 1000 m");
  await client.close();
});

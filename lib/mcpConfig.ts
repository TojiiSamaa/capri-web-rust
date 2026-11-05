// What the settings page may do to mcp.json: add and remove servers reached by URL. Never a command, which would run on this machine.
export const USE_CASES = [
  { name: "Mail", text: "Lire, chercher et envoyer des emails." },
  { name: "Logs", text: "Chercher et lire des logs pour comprendre une panne ou une erreur." },
  { name: "Actions sur serveurs Linux", text: "Inspecter des serveurs Linux et y lancer des actions : services, processus, disque, commandes." },
  { name: "Monitoring", text: "Consulter les métriques et les alertes des services." },
  { name: "Fichiers", text: "Lister, lire et modifier des fichiers." },
  { name: "Base de données", text: "Interroger une base de données et lire ses tables." },
  { name: "Calendrier", text: "Consulter et créer des événements de calendrier." },
  { name: "Web", text: "Chercher sur le web et lire des pages." },
];

// The server built into the app (infos.ts). It only reads or sets her own reminders, so its tools start out allowed, and it stays out of mcp.json.
export const INFOS_SERVER = "Capri Infos";
export const INFOS_USE_CASE = "Infos générales : date et heure, météo d'une ville, actualités, calculs et conversions, Wikipédia, rappels et minuteurs.";
export const INFOS_TOOLS = ["heure", "meteo", "actualites", "calcul", "convertir", "wikipedia", "rappel", "rappels", "annuler_rappel"].map((tool) => `Capri_Infos__${tool}`);
export const FIRST_INFOS_TOOLS = INFOS_TOOLS.slice(0, 3); // what settings marked `infosAllowed: true` were given

export type Config = { mcpServers?: Record<string, Record<string, unknown>> };
export type NewServer = { name: string; url: string; useCase: string; headers?: Record<string, string> };

// How the token travels. Any other header is set by hand in mcp.json.
export const TOKEN_KINDS = [
  { id: "bearer", label: "Authorization: Bearer", headers: (token: string) => ({ Authorization: `Bearer ${token}` }) },
  { id: "x-api-key", label: "x-api-key", headers: (token: string): Record<string, string> => ({ "x-api-key": token }) },
];
const MAX_TOKEN = 2000;

const MAX_NAME = 40;
const MAX_USE_CASE = 500;
export const safeName = (text: string) => text.replace(/[^a-zA-Z0-9_-]/g, "_");

// For the page: a URL can carry a token, in its query or before the host.
export function shownUrl(url: string) {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}${u.search ? "?…" : ""}`;
  } catch {
    return "URL invalide";
  }
}

export function parseNewServer(body: unknown): NewServer | string {
  const b = (body as Record<string, unknown> | null) ?? {};
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const url = typeof b.url === "string" ? b.url.trim() : "";
  const useCase = typeof b.useCase === "string" ? b.useCase.trim() : "";
  if (!name || name.length > MAX_NAME) return `Donne-lui un nom de ${MAX_NAME} caractères maximum.`;
  if (!useCase || useCase.length > MAX_USE_CASE) return `Décris son cas d'usage en ${MAX_USE_CASE} caractères maximum.`;
  try {
    if (!["http:", "https:"].includes(new URL(url).protocol)) throw new Error();
  } catch {
    return "L'URL doit commencer par http:// ou https://.";
  }
  const token = typeof b.token === "string" ? b.token.trim() : "";
  if (!token) return { name, url, useCase };
  if (token.length > MAX_TOKEN || !/^[\x21-\x7e]+$/.test(token)) return "Ce token n'est pas valide : pas d'espace ni de retour à la ligne.";
  const kind = TOKEN_KINDS.find((k) => k.id === b.tokenKind);
  if (!kind) return "Choisis comment envoyer le token.";
  return { name, url, useCase, headers: kind.headers(token) };
}

export function withServer(config: Config, server: NewServer): Config | string {
  const servers = config.mcpServers ?? {};
  // Compared on the name tools are built from, or "a b" and "a_b" would share their tools.
  if (Object.keys(servers).some((n) => safeName(n).toLowerCase() === safeName(server.name).toLowerCase())) return `Le serveur « ${server.name} » existe déjà.`;
  return { ...config, mcpServers: { ...servers, [server.name]: { url: server.url, useCase: server.useCase, ...(server.headers && { headers: server.headers }) } } };
}

export function withoutServer(config: Config, name: string): Config | string {
  const servers = { ...config.mcpServers };
  if (!Object.hasOwn(servers, name)) return "Ce serveur n'existe plus.";
  if (typeof servers[name].url !== "string") return "Ce serveur local se retire dans mcp.json.";
  delete servers[name];
  return { ...config, mcpServers: servers };
}

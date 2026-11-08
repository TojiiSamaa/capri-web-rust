// What the settings page offers for MCP servers reached by URL. The server (server-rs) checks and writes mcp.json; never a command, which would run on this machine.
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

// The server built into the app (server-rs/src/infos.rs). It only reads or sets her own reminders, so its tools start out allowed, and it stays out of mcp.json.
export const INFOS_SERVER = "Capri Infos";
export const INFOS_USE_CASE = "Infos générales : date et heure, météo d'une ville, actualités, calculs et conversions, Wikipédia, rappels et minuteurs.";
export const INFOS_TOOLS = ["heure", "meteo", "actualites", "calcul", "convertir", "wikipedia", "rappel", "rappels", "annuler_rappel"].map((tool) => `Capri_Infos__${tool}`);
export const FIRST_INFOS_TOOLS = INFOS_TOOLS.slice(0, 3); // what settings marked `infosAllowed: true` were given

// How the token travels. Any other header is set by hand in mcp.json.
export const TOKEN_KINDS = [
  { id: "bearer", label: "Authorization: Bearer", headers: (token: string) => ({ Authorization: `Bearer ${token}` }) },
  { id: "x-api-key", label: "x-api-key", headers: (token: string): Record<string, string> => ({ "x-api-key": token }) },
];

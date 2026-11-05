const LOCAL = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Other websites can send requests to localhost from your browser, and these routes hold your keys and run MCP tools.
// Only this app, on this machine, gets through. This also means the app can't be used once deployed, on purpose.
export function isLocalRequest(headers: Headers) {
  const host = headers.get("host") ?? "";
  if (!LOCAL.has(host.replace(/:\d+$/, ""))) return false; // also stops DNS rebinding
  const origin = headers.get("origin");
  if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return false;
  const site = headers.get("sec-fetch-site");
  return !site || site === "same-origin" || site === "none";
}

export const refused = () => Response.json({ error: "local_only" }, { status: 403 });

// MCP servers, connected from the Next server, as listed in mcp.json on this machine. The settings page can add
// servers reached by URL (see mcpConfig.ts); a command, which would run here, only ever comes from editing the file.
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { getDefaultEnvironment, StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { infosTransport } from "./infos.ts";
import { type Config, INFOS_SERVER, INFOS_USE_CASE, type NewServer, safeName, shownUrl, withoutServer, withServer } from "./mcpConfig.ts";

const CONFIG = join(process.cwd(), "mcp.json");
const CONNECT_TIMEOUT = 20_000;
const CALL_TIMEOUT = 120_000;
const MAX_RESULT = 16_000;

type Tool = { name: string; server: string; tool: string; description?: string; inputSchema: unknown };
type Server = { name: string; url?: string; useCase?: string; client?: Client; error?: string; tools: Tool[] };
type State = { stamp: number; error?: string; servers: Promise<Server[]> };

// Kept on globalThis so a hot reload doesn't start every server a second time.
const shared = globalThis as unknown as { capriMcp?: State; capriMcpQueue?: Promise<unknown> };

// One change at a time: two requests noticing a new mcp.json together would each start every server.
function inTurn<T>(run: () => Promise<T>) {
  const turn = (shared.capriMcpQueue ?? Promise.resolve()).then(run, run);
  shared.capriMcpQueue = turn.catch(() => {});
  return turn;
}

// Rejects if a server takes longer than ms, so one dead server can't hang a request.
function within<T>(promise: Promise<T>, ms: number) {
  return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`pas de réponse après ${ms / 1000} s`)), ms))]);
}

// Connects one server and lists its tools. A failure is kept on the server entry, so the others still work.
async function connect(name: string, config: Record<string, unknown>, builtIn?: Transport): Promise<Server> {
  const about = { name, url: typeof config.url === "string" ? config.url : undefined, useCase: typeof config.useCase === "string" ? config.useCase : undefined };
  const client = new Client({ name: "capri-web", version: "0.1.0" });
  try {
    const transport =
      builtIn ??
      (typeof config.url === "string"
        ? new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: (config.headers ?? {}) as Record<string, string> } })
        : new StdioClientTransport({
            command: String(config.command),
            args: (config.args ?? []) as string[],
            env: { ...getDefaultEnvironment(), ...((config.env ?? {}) as Record<string, string>) },
          }));
    await within(client.connect(transport), CONNECT_TIMEOUT);
    const tools: Tool[] = [];
    let cursor: string | undefined;
    do {
      const page = await within(client.listTools({ cursor }), CONNECT_TIMEOUT);
      for (const t of page.tools) {
        tools.push({ name: `${safeName(name)}__${safeName(t.name)}`.slice(0, 64), server: name, tool: t.name, description: t.description, inputSchema: t.inputSchema });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { ...about, client, tools };
  } catch (error) {
    await client.close().catch(() => {});
    return { ...about, error: error instanceof Error ? error.message : String(error), tools: [] };
  }
}

const state = (reload = false) => inTurn(() => refreshed(reload));

// Reuses the connections until mcp.json changes, or until a reload is asked for.
async function refreshed(reload: boolean): Promise<State> {
  const stamp = await stat(CONFIG).then((s) => s.mtimeMs, () => 0);
  const current = shared.capriMcp;
  if (current && current.stamp === stamp && !reload) return current;
  if (current) (await current.servers).forEach((s) => s.client?.close().catch(() => {}));
  let error: string | undefined;
  let entries: [string, Record<string, unknown>][] = [];
  if (stamp) {
    try {
      entries = Object.entries(JSON.parse(await readFile(CONFIG, "utf8")).mcpServers ?? {});
    } catch (e) {
      error = `mcp.json illisible : ${e instanceof Error ? e.message : e}`;
    }
  }
  const infos = connect(INFOS_SERVER, { useCase: INFOS_USE_CASE }, await infosTransport());
  const next: State = { stamp, error, servers: Promise.all([...entries.map(([name, config]) => connect(name, config)), infos]) };
  shared.capriMcp = next;
  return next;
}

// What the settings page shows: each server, whether it connected, and its tools.
export async function mcpStatus(reload = false) {
  const { error, servers } = await state(reload);
  return {
    error,
    servers: (await servers).map((s) => ({ name: s.name, url: s.url && shownUrl(s.url), useCase: s.useCase, connected: !!s.client, error: s.error, tools: s.tools.map((t) => ({ name: t.name, tool: t.tool })) })),
  };
}

// The tools in the form the chat API expects.
export async function chatTools() {
  const { servers } = await state();
  return (await servers).flatMap((s) =>
    s.tools.map((t) => ({ type: "function", function: { name: t.name, description: s.useCase ? `${t.description ?? t.tool}\n[Server "${s.name}", to use for: ${s.useCase}]` : t.description ?? t.tool, parameters: t.inputSchema } })),
  );
}

// Refuses to touch a file it can't read: rewriting it would lose whatever is in there.
async function changeConfig(change: (config: Config) => Config | string) {
  return inTurn(async () => {
    const raw = await readFile(CONFIG, "utf8").catch((e) => {
      if (e.code === "ENOENT") return "{}";
      throw e;
    });
    const next = change(JSON.parse(raw));
    if (typeof next === "string") return next;
    const draft = `${CONFIG}.tmp`;
    await writeFile(draft, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    await rename(draft, CONFIG); // all or nothing, so a crash can't leave half a file
    return null;
  });
}

export const addServer = (server: NewServer) => changeConfig((config) => withServer(config, server));
export const removeServer = (name: string) => changeConfig((config) => withoutServer(config, name));

// Runs a tool by its chat name, cutting a huge result. Null if no server has it.
export async function callTool(name: string, args: Record<string, unknown>) {
  const { servers } = await state();
  for (const server of await servers) {
    const tool = server.tools.find((t) => t.name === name);
    if (!tool || !server.client) continue;
    const result = await server.client.callTool({ name: tool.tool, arguments: args }, undefined, { timeout: CALL_TIMEOUT });
    const parts = (result.content ?? []) as { type: string; text?: string }[];
    const text = parts.map((p) => (p.type === "text" ? p.text : `[contenu ${p.type} non affiché]`)).join("\n") || "(aucun contenu)";
    return { text: text.length > MAX_RESULT ? `${text.slice(0, MAX_RESULT)}\n[résultat coupé]` : text, isError: !!result.isError };
  }
  return null;
}

// Everything the page can do with MCP servers. Local requests only: these routes run tools and touch mcp.json.
import { isLocalRequest, refused } from "@/lib/guard";
import { addServer, callTool, mcpStatus, removeServer } from "@/lib/mcp";
import { parseNewServer } from "@/lib/mcpConfig";

async function changed(change: () => Promise<string | null>) {
  try {
    const problem = await change();
    if (problem) return Response.json({ problem }, { status: 400 });
    return Response.json(await mcpStatus());
  } catch (error) {
    console.error("[mcp] mcp.json", error);
    return Response.json({ problem: "Impossible de modifier mcp.json. Vérifie que ce fichier est valide." }, { status: 500 });
  }
}

// Adds a server reached by URL.
export async function PUT(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const server = parseNewServer(await req.json().catch(() => null));
  if (typeof server === "string") return Response.json({ problem: server }, { status: 400 });
  return changed(() => addServer(server));
}

// Removes a server added by URL.
export async function DELETE(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const name = (await req.json().catch(() => null))?.name;
  if (typeof name !== "string") return Response.json({ problem: "Quel serveur ?" }, { status: 400 });
  return changed(() => removeServer(name));
}

// Lists servers and their tools; ?reload reconnects them.
export async function GET(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  return Response.json(await mcpStatus(new URL(req.url).searchParams.has("reload")));
}

// Runs one tool the model asked for, once the page has allowed it.
export async function POST(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  const b = await req.json().catch(() => null);
  const args = b?.arguments;
  if (typeof b?.name !== "string" || typeof args !== "object" || args === null || Array.isArray(args)) return Response.json({ error: "bad_request" }, { status: 400 });
  try {
    const result = await callTool(b.name, args);
    if (!result) return Response.json({ error: "unknown_tool" }, { status: 404 });
    return Response.json(result);
  } catch (error) {
    console.error("[mcp]", b.name, error);
    return Response.json({ text: `L'outil a échoué : ${error instanceof Error ? error.message : error}`, isError: true });
  }
}

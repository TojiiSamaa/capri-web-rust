// Hands reminders that are due to the page, which announces them.
import { isLocalRequest, refused } from "@/lib/guard";
import { store } from "@/lib/store";

const HIDDEN_WAIT = 30_000;

// The page asks what's due, and each reminder is handed over once. A tab in front gets it first; a hidden one only if none took it.
export async function POST(req: Request) {
  if (!isLocalRequest(req.headers)) return refused();
  return Response.json({ due: store().takeDueReminders(Date.now() - (new URL(req.url).searchParams.has("hidden") ? HIDDEN_WAIT : 0)) });
}

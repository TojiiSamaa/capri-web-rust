// What a chat message looks like on the way to the server (server-rs/src/messages.rs validates it).
export type ToolCall = { id: string; type: "function"; function: { name: string; arguments: string } };
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export const MAX_CHARS = 500; // the longest line she hears or types

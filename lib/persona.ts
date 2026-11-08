import texts from "../shared/persona.json" with { type: "json" };

// The base character text, shown in the settings. The server builds the whole prompt (server-rs/src/persona.rs).
export const BASE: string = texts.base;

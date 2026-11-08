import type { NextConfig } from "next";

// A static export: the Rust server (server-rs) serves out/ and every /api route.
const config: NextConfig = { output: "export", trailingSlash: true };
export default config;

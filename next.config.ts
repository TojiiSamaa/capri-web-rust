import type { NextConfig } from "next";

// The Docker image sets CAPRI_STANDALONE to ship only what the server uses; `npm start` keeps the normal build.
const config: NextConfig = { output: process.env.CAPRI_STANDALONE ? "standalone" : undefined };
export default config;

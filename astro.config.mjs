// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import tailwindcss from "@tailwindcss/vite";

// The dashboard is a static Astro site in dist/, served by Workers static
// assets; the Worker (src/) handles /api, /agents and /openapi.json first.
// Same shape as cf-pm-sdk-deck. web/ keeps it apart from the Worker code.
export default defineConfig({
  srcDir: "./web",
  outDir: "./dist",
  publicDir: "./public",
  integrations: [react()],
  vite: { plugins: [tailwindcss()] },
});

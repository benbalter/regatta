// Emit public/openapi.json from the single source of truth (src/schemas.ts +
// src/api.ts), so the contract is readable without running anything.
// Run with tsx: the API module's imports avoid Workers-only modules.
import { mkdirSync, writeFileSync } from "node:fs";
import { getOpenAPISpec } from "../src/api";

const spec = getOpenAPISpec();
mkdirSync("public", { recursive: true });
writeFileSync("public/openapi.json", `${JSON.stringify(spec, null, 2)}\n`);
console.log(`✓ openapi: public/openapi.json (${Object.keys(spec.paths ?? {}).length} paths)`);

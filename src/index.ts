import { routeAgentRequest } from "agents";
import { app, getOpenAPISpec } from "./api";
import { handleMcp } from "./mcp";

export { Race } from "./race";
export { Sandbox, Egress } from "./sandbox";
export { AttemptWorkflow } from "./attempt";
export { LandWorkflow } from "./land";
export { SyncWorkflow } from "./sync";
export { DecisionWorkflow } from "./decision-workflow";

// The contract, live. scripts/build-openapi.ts writes the same document to public/openapi.json.
app.get("/openapi.json", (c) => c.json(getOpenAPISpec()));

// /mcp is Regatta for agents (MCP). Dashboards subscribe to a race at
// /agents/race/<id> (Agents SDK state sync, read-only). Everything else is the
// HTTP API. Static assets are served before this.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (new URL(request.url).pathname === "/mcp") return handleMcp(request, env, ctx);
    return (await routeAgentRequest(request, env)) ?? app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

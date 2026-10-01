import { routeAgentRequest } from "agents";
import { app, getOpenAPISpec } from "./api";

export { Race } from "./race";
export { Sandbox, Egress } from "./sandbox";
export { AttemptWorkflow } from "./attempt";
export { LandWorkflow } from "./land";
export { SyncWorkflow } from "./sync";
export { DecisionWorkflow } from "./decision-workflow";

// The contract, live. scripts/build-openapi.ts writes the same document to public/openapi.json.
app.get("/openapi.json", (c) => c.json(getOpenAPISpec()));

// Dashboards subscribe to a race at /agents/race/<id> (Agents SDK state sync,
// read-only); everything else is the API. Static assets are served before this.
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? app.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;

import { app, getOpenAPISpec } from "./api";
import { UI } from "./ui";

export { Race } from "./race";
export { Sandbox, Egress } from "./sandbox";
export { AttemptWorkflow } from "./attempt";
export { LandWorkflow } from "./land";
export { SyncWorkflow } from "./sync";

app.get("/", (c) => c.html(UI));
// The contract, live. scripts/build-openapi.ts writes the same document to public/openapi.json.
app.get("/openapi.json", (c) => c.json(getOpenAPISpec()));

export default app;

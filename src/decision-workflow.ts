// Writes decision docs, and their dissents, for clusters escalated to review.
// One durable step per model call, so a crash doesn't pay for a doc twice.

import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { complete, parseModel } from "./agent";
import { basisOf, DissentBody, DocBody, dissentPrompt, docPrompt, needsDoc, parseJsonReply } from "./decision";
import type { DecisionDoc } from "./schemas";

export interface DecisionParams {
  raceId: string;
}

export class DecisionWorkflow extends WorkflowEntrypoint<Env, DecisionParams> {
  async run(event: WorkflowEvent<DecisionParams>, step: WorkflowStep) {
    const race = this.env.Race.getByName(event.payload.raceId);
    const docModel = parseModel(this.env.REGATTA_AGENT_MODEL);
    const dissentModel = parseModel(this.env.REGATTA_DISSENT_MODEL);

    const todo = await step.do("plan", async () => {
      const v = await race.view();
      if (!v) return [];
      return needsDoc(v.clusters, v.decisionDocs).map((c) => ({ cluster: c, prompt: docPrompt(v.spec.intent, c, v.attempts) }));
    });

    for (const { cluster, prompt } of todo) {
      const body = await step.do(`doc-${cluster.key}`, { retries: { limit: 2, delay: "10 seconds" } }, async () => {
        const text = await complete(this.env, docModel, prompt.system, prompt.user);
        const parsed = parseJsonReply(text, DocBody);
        // A doc that won't parse still beats no doc: keep the prose as the problem statement.
        return parsed ?? { problem: text.trim(), options: [], recommendation: "(the model did not return a structured recommendation)", ask: "Review the attempts directly." };
      });

      const dissent = await step.do(`dissent-${cluster.key}`, { retries: { limit: 2, delay: "10 seconds" } }, async () => {
        const d = dissentPrompt(body, cluster);
        const parsed = parseJsonReply(await complete(this.env, dissentModel, d.system, d.user), DissentBody);
        return parsed ? { ...parsed, model: `${dissentModel.provider}:${dissentModel.model}` } : null;
      });

      const doc: DecisionDoc = {
        clusterKey: cluster.key,
        basis: basisOf(cluster),
        ...body,
        dissent,
        model: `${docModel.provider}:${docModel.model}`,
        generatedAt: new Date().toISOString(),
      };
      await step.do(`store-${cluster.key}`, () => race.storeDecision(doc));
    }
  }
}

import type { DatabaseSync } from "node:sqlite";
import { QuoteOutcomeSchema, QuoteRequestSchema } from "@crm-agent/contracts";
import type { QuoteService } from "./ports";

type Engine = {
  preview(input: unknown, evidence: unknown[]): { outcome: unknown; commit(): void };
};
type EngineConstructor = new (database: DatabaseSync, config: unknown) => Engine;

/** C-05 calculation preview; A-04 invokes its retained commit inside the UOW. */
export class SqliteQuoteService implements QuoteService {
  private readonly commits = new Map<string, () => void>();

  constructor(private readonly database: DatabaseSync) {}

  async calculate(
    input: Parameters<QuoteService["calculate"]>[0],
    evidence: import("@crm-agent/contracts").KnowledgeEvidence[] = [],
  ) {
    const request = QuoteRequestSchema.parse(input);
    const { DeterministicQuoteEngine } = require("@crm-agent/quote-engine") as {
      DeterministicQuoteEngine: EngineConstructor;
    };
    const presentations = Object.fromEntries(request.candidate_rule_ids.map((ruleId) => [ruleId, {
      label: ruleId, category: "construction",
    }]));
    const engine = new DeterministicQuoteEngine(this.database, {
      rule_presentations: presentations,
      disclaimer: "本结果为本地估算，最终金额以正式合同为准。",
    });
    const preview = engine.preview({ request, intent_level: "medium" }, evidence);
    const outcome = QuoteOutcomeSchema.parse(preview.outcome);
    if (outcome.kind === "quote") this.commits.set(request.turn_id, preview.commit);
    return outcome;
  }

  take_commit(turnId: string) {
    const commit = this.commits.get(turnId);
    this.commits.delete(turnId);
    return commit;
  }
}

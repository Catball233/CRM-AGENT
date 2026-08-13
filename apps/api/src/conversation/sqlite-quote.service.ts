import type { DatabaseSync } from "node:sqlite";
import { QuoteOutcomeSchema, QuoteRequestSchema, type QuoteParameters } from "@crm-agent/contracts";
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
    _evidence: import("@crm-agent/contracts").KnowledgeEvidence[] = [],
  ) {
    const request = QuoteRequestSchema.parse(input);
    const candidateRuleIds = request.candidate_rule_ids.length > 0
      ? request.candidate_rule_ids
      : this.findApplicableActiveRuleIds(request.confirmed_parameters, request.requested_at);
    if (candidateRuleIds.length === 0) {
      return QuoteOutcomeSchema.parse({
        kind: "unavailable",
        unavailable: {
          contract_version: "1.0.0",
          reason: "no_active_rule",
          missing_fields: [],
          conflicting_rule_ids: [],
          user_safe_message: "当前地区和服务范围没有可用的本地报价规则，已转人工继续协助。",
        },
      });
    }
    const localRequest = QuoteRequestSchema.parse({
      ...request,
      candidate_rule_ids: candidateRuleIds,
      knowledge_evidence_ids: [],
    });
    const { DeterministicQuoteEngine } = require("@crm-agent/quote-engine") as {
      DeterministicQuoteEngine: EngineConstructor;
    };
    const presentations = Object.fromEntries(candidateRuleIds.map((ruleId) => [ruleId, {
      label: ruleId, category: "construction",
    }]));
    const engine = new DeterministicQuoteEngine(this.database, {
      rule_presentations: presentations,
      disclaimer: "本结果为本地估算，最终金额以正式合同为准。",
    });
    const preview = engine.preview({ request: localRequest, intent_level: "medium" }, []);
    const outcome = QuoteOutcomeSchema.parse(preview.outcome);
    if (outcome.kind === "quote") this.commits.set(request.turn_id, preview.commit);
    return outcome;
  }

  take_commit(turnId: string) {
    const commit = this.commits.get(turnId);
    this.commits.delete(turnId);
    return commit;
  }

  private findApplicableActiveRuleIds(parameters: QuoteParameters, requestedAt: string) {
    const rows = this.database.prepare(
      "SELECT rule_id, conditions_json FROM rule_versions " +
      "WHERE status = 'active' AND city = ? AND datetime(effective_from) <= datetime(?) " +
      "AND (effective_to IS NULL OR datetime(effective_to) > datetime(?))",
    ).all(parameters.city, requestedAt, requestedAt) as Array<{ rule_id: string; conditions_json: string }>;
    const values = parameters as Record<string, unknown>;
    return rows
      .filter((row) => {
        try {
          const conditions = JSON.parse(row.conditions_json) as Record<string, unknown>;
          return Object.entries(conditions).every(([key, expected]) => values[key] === expected);
        } catch {
          return false;
        }
      })
      .map((row) => row.rule_id)
      .sort();
  }
}

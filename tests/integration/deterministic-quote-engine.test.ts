import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DeterministicQuoteEngine,
  floorRevenueFen,
  type DeterministicQuoteInput,
  type QuoteEngineConfig,
} from "../../packages/quote-engine/src/index";
import { migrateDatabase, openDatabase } from "../../database/scripts/sqlite.mjs";

const projectRoot = resolve(import.meta.dirname, "../..");
const migrationDirectory = resolve(projectRoot, "database/migrations");
const temporaryDirectories: string[] = [];
const at = "2026-08-06T08:00:00Z";
const manualReconciliation = JSON.parse(readFileSync(
  resolve(projectRoot, "data/quote-rule-samples/c05-manual-reconciliation.json"),
  "utf8",
)) as { expected: Record<string, number> };
const ids = {
  conversation: "50000000-0000-4000-8000-000000000001",
  turn: "50000000-0000-4000-8000-000000000002",
  userMessage: "50000000-0000-4000-8000-000000000003",
  evidence: "50000000-0000-4000-8000-000000000004",
  designRule: "50000000-0000-4000-8000-000000000005",
  designCostRule: "50000000-0000-4000-8000-000000000006",
  bundle: "50000000-0000-4000-8000-000000000007",
  cashPromotion: "50000000-0000-4000-8000-000000000008",
  giftPromotion: "50000000-0000-4000-8000-000000000009",
  servicePromotion: "50000000-0000-4000-8000-000000000010",
  supplier: "50000000-0000-4000-8000-000000000011",
  procurementRule: "50000000-0000-4000-8000-000000000012",
};

function database() {
  const directory = mkdtempSync(join(tmpdir(), "crm-agent-c05-"));
  temporaryDirectories.push(directory);
  const db = openDatabase(join(directory, "test.sqlite"));
  migrateDatabase(db, migrationDirectory);
  return db;
}

function insertConversationAndTurn(
  db: ReturnType<typeof openDatabase>,
  conversationId = ids.conversation,
  turnId = ids.turn,
  userMessageId = ids.userMessage,
) {
  db.prepare(`INSERT OR IGNORE INTO conversations (
    conversation_id, stage, status, created_at, updated_at
  ) VALUES (?, 'QUOTING', 'ACTIVE', ?, ?)`).run(conversationId, at, at);
  db.prepare(`INSERT INTO turns (
    turn_id, conversation_id, client_message_id, status, started_at
  ) VALUES (?, ?, ?, 'PROCESSING', ?)`).run(turnId, conversationId, userMessageId, at);
}

function insertEvidence(
  db: ReturnType<typeof openDatabase>,
  candidateRuleIds: string[],
  evidenceId = ids.evidence,
  turnId = ids.turn,
  conversationId = ids.conversation,
  score = 0.9,
) {
  db.prepare(`INSERT INTO knowledge_evidence (
    evidence_id, conversation_id, turn_id, knowledge_base_id, document_id, document_version,
    chunk_id, title, excerpt, score, metadata_json, candidate_rule_ids_json, created_at
  ) VALUES (?, ?, ?, 'fixture-kb', 'fixture-doc', '0.2.0', ?, '虚构报价依据',
    '仅用于 C-05 测试的虚构报价规则。', ?, '{}', ?, ?)`)
    .run(evidenceId, conversationId, turnId, `chunk-${evidenceId}`, score, JSON.stringify(candidateRuleIds), at);
}

interface RuleFixture {
  ruleVersionId: string;
  ruleId: string;
  version?: number;
  city?: string;
  calculationType: "FIXED_AMOUNT" | "AREA_MULTIPLY" | "QUANTITY_MULTIPLY" | "TIER_COEFFICIENT" | "CONDITIONAL_SURCHARGE" | "MINIMUM_PRICE";
  amountFen?: number;
  unitPriceFen?: number;
  coefficient?: number;
  baseRuleId?: string;
  minimumPriceFen?: number;
  conditions?: Record<string, string | number | boolean>;
  conflictGroup?: string;
  effectiveTo?: string;
}

function insertRule(db: ReturnType<typeof openDatabase>, rule: RuleFixture) {
  db.prepare(`INSERT INTO rule_versions (
    rule_version_id, rule_id, version, status, city, calculation_type, amount_fen,
    unit_price_fen, coefficient, base_rule_id, minimum_price_fen, conditions_json,
    conflict_group, effective_from, effective_to, source_document, source_version,
    fixture_owner, fixture_reviewer, created_at, validated_at, activated_at
  ) VALUES (?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01T00:00:00Z', ?,
    'fixtures/C05-rules.json', '1.0.0', 'C', 'A', ?, ?, ?)`)
    .run(
      rule.ruleVersionId, rule.ruleId, rule.version ?? 1, rule.city ?? "北京", rule.calculationType,
      rule.amountFen ?? null, rule.unitPriceFen ?? null, rule.coefficient ?? null,
      rule.baseRuleId ?? null, rule.minimumPriceFen ?? null, JSON.stringify(rule.conditions ?? {}),
      rule.conflictGroup ?? null, rule.effectiveTo ?? "2027-01-01T00:00:00Z", at, at, at,
    );
}

function insertGuardrail(
  db: ReturnType<typeof openDatabase>,
  ruleVersionId: string,
  options: {
    minimumMarginBps?: number;
    maximumDiscountBps?: number;
    costRuleRefs?: string[];
    supplierRefs?: string[];
    giftCostFen?: number;
    freeServiceCostFen?: number;
  } = {},
) {
  db.prepare(`INSERT INTO rule_guardrails (
    rule_version_id, minimum_margin_bps, maximum_discount_bps, cost_rule_refs_json,
    supplier_quote_snapshot_refs_json, gift_cost_fen, free_service_cost_fen
  ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(
      ruleVersionId, options.minimumMarginBps ?? 2_000, options.maximumDiscountBps ?? 1_500,
      JSON.stringify(options.costRuleRefs ?? []), JSON.stringify(options.supplierRefs ?? []),
      options.giftCostFen ?? 0, options.freeServiceCostFen ?? 0,
    );
}

function insertBundle(db: ReturnType<typeof openDatabase>) {
  db.prepare(`INSERT OR IGNORE INTO rule_import_bundles (
    bundle_id, contract_version, source_format, source_document, source_version,
    fixture_owner, fixture_reviewer, reconciliation_fixture_ids_json, status,
    imported_at, validated_at, activated_at
  ) VALUES (?, '1.0.0', 'json', 'fixtures/C05-rules.json', '1.0.0', 'C', 'A', '[]',
    'active', ?, ?, ?)`).run(ids.bundle, at, at, at);
}

function insertPromotion(
  db: ReturnType<typeof openDatabase>,
  promotionRuleVersionId: string,
  promotionId: string,
  benefitType: "cash_discount" | "gift" | "free_service",
  options: { discountBps?: number; benefitCostFen?: number; intent?: string[]; priority?: number; stackable?: boolean } = {},
) {
  insertBundle(db);
  db.prepare(`INSERT INTO promotion_rule_versions (
    promotion_rule_version_id, bundle_id, promotion_id, version, status, city,
    intent_levels_json, benefit_type, discount_bps, benefit_cost_fen,
    minimum_subtotal_fen, priority, exclusion_group, stackable, effective_from,
    effective_to, validated_at, activated_at
  ) VALUES (?, ?, ?, 1, 'active', '北京', ?, ?, ?, ?, 0, ?, NULL, ?,
    '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', ?, ?)`)
    .run(
      promotionRuleVersionId, ids.bundle, promotionId, JSON.stringify(options.intent ?? ["low"]),
      benefitType, options.discountBps ?? null, options.benefitCostFen ?? 0,
      options.priority ?? 10, options.stackable ? 1 : 0, at, at,
    );
}

function baseSetup(db: ReturnType<typeof openDatabase>, evidenceScore = 0.9) {
  insertConversationAndTurn(db);
  insertRule(db, {
    ruleVersionId: ids.designRule,
    ruleId: "FIXTURE-C05-DESIGN-STANDARD",
    calculationType: "AREA_MULTIPLY",
    unitPriceFen: 13_750,
    conditions: { scene: "整装", designer_tier: "标准" },
  });
  insertRule(db, {
    ruleVersionId: ids.designCostRule,
    ruleId: "FIXTURE-C05-COST-DESIGN",
    calculationType: "AREA_MULTIPLY",
    unitPriceFen: 9_900,
    conditions: { scene: "整装" },
  });
  insertGuardrail(db, ids.designRule, { costRuleRefs: ["FIXTURE-C05-COST-DESIGN"] });
  insertEvidence(db, ["FIXTURE-C05-DESIGN-STANDARD"], ids.evidence, ids.turn, ids.conversation, evidenceScore);
}

const config: QuoteEngineConfig = {
  rule_presentations: {
    "FIXTURE-C05-DESIGN-STANDARD": { label: "标准设计服务", category: "design", unit: "平方米" },
    "FIXTURE-C05-DESIGN-SENIOR": { label: "资深设计服务", category: "design", unit: "平方米" },
    "FIXTURE-C05-MATERIAL": { label: "标准材料套餐", category: "material", unit: "套", quantity_key: "material_package" },
    "FIXTURE-C05-CONSTRUCTION": { label: "基础施工服务", category: "construction" },
    "FIXTURE-C05-PROCUREMENT": { label: "家具家电代采套餐", category: "material" },
    "FIXTURE-C05-CONFLICT": { label: "冲突设计方案", category: "design", unit: "平方米" },
  },
  minimum_evidence_score: 0.5,
  quote_validity_seconds: 86_400,
  assumptions: ["本报价使用虚构测试规则计算。"],
  exclusions: ["现场增项需另行确认。"],
  disclaimer: "本报价为测试用预估结果，最终金额以现场确认和正式合同为准。",
};

function quoteInput(overrides: Partial<DeterministicQuoteInput> = {}): DeterministicQuoteInput {
  const base: DeterministicQuoteInput = {
    request: {
      contract_version: "1.0.0",
      conversation_id: ids.conversation,
      turn_id: ids.turn,
      confirmed_parameters: {
        city: "北京",
        area_sqm: 80,
        house_state: "rough",
        service_scope: "whole_home",
        material_tier: "标准",
        designer_tier: "标准",
        quantities: {},
        special_requirements: [],
      },
      candidate_rule_ids: ["FIXTURE-C05-DESIGN-STANDARD"],
      knowledge_evidence_ids: [ids.evidence],
      requested_at: at,
    },
    intent_level: "high",
    candidate_promotion_ids: [],
    promotion_required: false,
  };
  return { ...base, ...overrides };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("C-05 deterministic quote engine", () => {
  it("previews supplied evidence without leaving quote or evidence rows behind", () => {
    const db = database();
    try {
      baseSetup(db);
      db.prepare("DELETE FROM knowledge_evidence WHERE evidence_id = ?").run(ids.evidence);
      const preview = new DeterministicQuoteEngine(db, config).preview(quoteInput(), [{
        contract_version: "1.0.0",
        evidence_id: ids.evidence,
        knowledge_base_id: "fixture-kb",
        document_id: "fixture-doc",
        document_version: "0.2.0",
        chunk_id: "preview-chunk",
        title: "预览报价依据",
        excerpt: "仅用于预览测试。",
        score: 0.9,
        metadata: {},
        candidate_rule_ids: ["FIXTURE-C05-DESIGN-STANDARD"],
      }]);
      expect(preview.outcome).toMatchObject({ kind: "quote" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM knowledge_evidence").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_internal_calculations").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("isolates a preview with a savepoint when its caller owns the transaction", () => {
    const db = database();
    try {
      baseSetup(db);
      db.prepare("DELETE FROM knowledge_evidence WHERE evidence_id = ?").run(ids.evidence);
      db.exec("BEGIN IMMEDIATE");
      db.prepare("UPDATE conversations SET stage = 'QUALIFYING' WHERE conversation_id = ?").run(ids.conversation);
      const preview = new DeterministicQuoteEngine(db, config).preview(quoteInput(), [{
        contract_version: "1.0.0", evidence_id: ids.evidence, knowledge_base_id: "fixture-kb",
        document_id: "fixture-doc", document_version: "0.2.0", chunk_id: "nested-preview",
        title: "嵌套预览依据", excerpt: "仅用于事务测试。", score: 0.9, metadata: {},
        candidate_rule_ids: ["FIXTURE-C05-DESIGN-STANDARD"],
      }]);
      expect(preview.outcome).toMatchObject({ kind: "quote" });
      db.exec("COMMIT");
      expect(db.prepare("SELECT stage FROM conversations WHERE conversation_id = ?").get(ids.conversation)).toEqual({ stage: "QUALIFYING" });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 0 });
    } finally {
      if (db.isTransaction) db.exec("ROLLBACK");
      db.close();
    }
  });

  it("matches the manually reconciled area quote using integer fen", () => {
    const db = database();
    try {
      baseSetup(db);
      const engine = new DeterministicQuoteEngine(db, config);
      const outcome = engine.quote(quoteInput());
      expect(outcome.kind).toBe("quote");
      if (outcome.kind !== "quote") throw new Error("expected quote");
      expect(outcome.quote).toMatchObject({ estimated_total_fen: 1_100_000, quote_version: 1 });
      expect(outcome.quote.items[0]).toMatchObject({
        quantity: 80,
        unit_price_fen: 13_750,
        amount_fen: 1_100_000,
      });
      expect(engine.getInternalCalculation(outcome.quote.quote_id)).toMatchObject({
        revenue_subtotal_fen: manualReconciliation.expected.revenue_subtotal_fen,
        direct_cost_fen: manualReconciliation.expected.total_cost_fen,
        total_cost_fen: manualReconciliation.expected.total_cost_fen,
        floor_revenue_fen: manualReconciliation.expected.floor_revenue_fen,
        final_revenue_fen: 1_100_000,
      });
    } finally {
      db.close();
    }
  });

  it("applies a low-intent cash promotion exactly at the profit floor", () => {
    const db = database();
    try {
      baseSetup(db);
      insertPromotion(db, ids.cashPromotion, "FIXTURE-C05-CASH-10", "cash_discount", {
        discountBps: 1_000,
        intent: ["low"],
      });
      const engine = new DeterministicQuoteEngine(db, config);
      const outcome = engine.quote(quoteInput({
        intent_level: "low",
        candidate_promotion_ids: ["FIXTURE-C05-CASH-10"],
        promotion_required: true,
      }));
      expect(outcome.kind).toBe("quote");
      if (outcome.kind !== "quote") throw new Error("expected quote");
      expect(outcome.quote.estimated_total_fen).toBe(990_000);
      expect(engine.getInternalCalculation(outcome.quote.quote_id)).toMatchObject({
        approved_discount_fen: manualReconciliation.expected.approved_discount_fen,
        floor_revenue_fen: manualReconciliation.expected.floor_revenue_fen,
        rule_discount_cap_fen: manualReconciliation.expected.rule_discount_cap_fen,
        margin_headroom_fen: manualReconciliation.expected.margin_headroom_fen,
        final_revenue_fen: manualReconciliation.expected.final_revenue_fen,
      });
    } finally {
      db.close();
    }
  });

  it("rejects a promotion that would put revenue below the floor", () => {
    const db = database();
    try {
      baseSetup(db);
      insertPromotion(db, ids.cashPromotion, "FIXTURE-C05-CASH-OVER", "cash_discount", {
        discountBps: 1_001,
        intent: ["low"],
      });
      const outcome = new DeterministicQuoteEngine(db, config).quote(quoteInput({
        intent_level: "low",
        candidate_promotion_ids: ["FIXTURE-C05-CASH-OVER"],
        promotion_required: true,
      }));
      expect(outcome).toMatchObject({ kind: "unavailable", unavailable: { reason: "rule_not_applicable" } });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 0 });
      expect(floorRevenueFen(800_000, 2_000)).toBe(1_000_000);
    } finally {
      db.close();
    }
  });

  it.each([
    ["gift", ids.giftPromotion, "FIXTURE-C05-GIFT", 20_000],
    ["free_service", ids.servicePromotion, "FIXTURE-C05-FREE-SERVICE", 30_000],
  ] as const)("counts %s benefit cost without exposing it in the customer quote", (type, promotionVersionId, promotionId, cost) => {
    const db = database();
    try {
      baseSetup(db);
      insertPromotion(db, promotionVersionId, promotionId, type, { benefitCostFen: cost, intent: ["low"] });
      const engine = new DeterministicQuoteEngine(db, config);
      const outcome = engine.quote(quoteInput({
        intent_level: "low",
        candidate_promotion_ids: [promotionId],
        promotion_required: true,
      }));
      expect(outcome.kind).toBe("quote");
      if (outcome.kind !== "quote") throw new Error("expected quote");
      const ledger = engine.getInternalCalculation(outcome.quote.quote_id);
      expect(type === "gift" ? ledger.gift_cost_fen : ledger.free_service_cost_fen).toBe(cost);
      expect(JSON.stringify(outcome.quote)).not.toContain("total_cost_fen");
      expect(JSON.stringify(outcome.quote)).not.toContain("supplier");
    } finally {
      db.close();
    }
  });

  it("calculates furniture and appliance procurement from an unexpired wholesale snapshot", () => {
    const db = database();
    try {
      baseSetup(db);
      insertBundle(db);
      insertRule(db, {
        ruleVersionId: ids.procurementRule,
        ruleId: "FIXTURE-C05-PROCUREMENT",
        calculationType: "FIXED_AMOUNT",
        amountFen: 500_000,
      });
      db.prepare(`INSERT INTO supplier_quote_snapshots (
        supplier_quote_snapshot_id, bundle_id, supplier_ref, quote_version, region, currency,
        valid_from, valid_to, captured_at, items_json
      ) VALUES (?, ?, 'FIXTURE-SUPPLIER', '1', '北京', 'CNY', '2026-08-01T00:00:00Z',
        '2026-09-01T00:00:00Z', '2026-08-01T01:00:00Z', ?)`)
        .run(ids.supplier, ids.bundle, JSON.stringify([{
          item_ref: "FIXTURE-APPLIANCE",
          category: "appliance",
          quantity: 1,
          wholesale_cost_fen: 300_000,
          delivery_cost_fen: 10_000,
          installation_cost_fen: 5_000,
          warranty_cost_fen: 2_000,
        }]));
      insertGuardrail(db, ids.procurementRule, { supplierRefs: [ids.supplier] });
      db.prepare("UPDATE knowledge_evidence SET candidate_rule_ids_json = ? WHERE evidence_id = ?")
        .run(JSON.stringify(["FIXTURE-C05-DESIGN-STANDARD", "FIXTURE-C05-PROCUREMENT"]), ids.evidence);
      const engine = new DeterministicQuoteEngine(db, config);
      const input = quoteInput();
      const outcome = engine.quote({
        ...input,
        request: { ...input.request, candidate_rule_ids: ["FIXTURE-C05-DESIGN-STANDARD", "FIXTURE-C05-PROCUREMENT"] },
      });
      expect(outcome.kind).toBe("quote");
      if (outcome.kind !== "quote") throw new Error("expected quote");
      expect(outcome.quote.estimated_total_fen).toBe(1_600_000);
      expect(engine.getInternalCalculation(outcome.quote.quote_id)).toMatchObject({
        procurement_cost_fen: 317_000,
        supplier_snapshot_refs: [ids.supplier],
      });
    } finally {
      db.close();
    }
  });

  it("refuses procurement when its supplier snapshot has expired", () => {
    const db = database();
    try {
      baseSetup(db);
      insertBundle(db);
      insertRule(db, {
        ruleVersionId: ids.procurementRule,
        ruleId: "FIXTURE-C05-PROCUREMENT",
        calculationType: "FIXED_AMOUNT",
        amountFen: 500_000,
      });
      db.prepare(`INSERT INTO supplier_quote_snapshots (
        supplier_quote_snapshot_id, bundle_id, supplier_ref, quote_version, region, currency,
        valid_from, valid_to, captured_at, items_json
      ) VALUES (?, ?, 'FIXTURE-SUPPLIER', 'expired', '北京', 'CNY', '2026-01-01T00:00:00Z',
        '2026-08-01T00:00:00Z', '2026-01-01T01:00:00Z', '[]')`).run(ids.supplier, ids.bundle);
      insertGuardrail(db, ids.procurementRule, { supplierRefs: [ids.supplier] });
      db.prepare("UPDATE knowledge_evidence SET candidate_rule_ids_json = ? WHERE evidence_id = ?")
        .run(JSON.stringify(["FIXTURE-C05-DESIGN-STANDARD", "FIXTURE-C05-PROCUREMENT"]), ids.evidence);
      const input = quoteInput();
      const outcome = new DeterministicQuoteEngine(db, config).quote({
        ...input,
        request: { ...input.request, candidate_rule_ids: ["FIXTURE-C05-DESIGN-STANDARD", "FIXTURE-C05-PROCUREMENT"] },
      });
      expect(outcome.kind).toBe("unavailable");
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });

  it("handles designer tiers and quantity material rules deterministically", () => {
    const db = database();
    try {
      baseSetup(db);
      const seniorId = "50000000-0000-4000-8000-000000000021";
      const materialId = "50000000-0000-4000-8000-000000000022";
      insertRule(db, {
        ruleVersionId: seniorId,
        ruleId: "FIXTURE-C05-DESIGN-SENIOR",
        calculationType: "AREA_MULTIPLY",
        unitPriceFen: 18_000,
        conditions: { designer_tier: "资深", scene: "整装" },
      });
      insertGuardrail(db, seniorId, { costRuleRefs: ["FIXTURE-C05-COST-DESIGN"] });
      insertRule(db, {
        ruleVersionId: materialId,
        ruleId: "FIXTURE-C05-MATERIAL",
        calculationType: "QUANTITY_MULTIPLY",
        unitPriceFen: 200_000,
        conditions: { material_tier: "标准" },
      });
      insertGuardrail(db, materialId);
      db.prepare("UPDATE knowledge_evidence SET candidate_rule_ids_json = ? WHERE evidence_id = ?")
        .run(JSON.stringify(["FIXTURE-C05-DESIGN-SENIOR", "FIXTURE-C05-MATERIAL"]), ids.evidence);
      const input = quoteInput();
      const outcome = new DeterministicQuoteEngine(db, config).quote({
        ...input,
        request: {
          ...input.request,
          confirmed_parameters: {
            ...input.request.confirmed_parameters,
            designer_tier: "资深",
            quantities: { material_package: 2 },
          },
          candidate_rule_ids: ["FIXTURE-C05-DESIGN-SENIOR", "FIXTURE-C05-MATERIAL"],
        },
      });
      expect(outcome.kind).toBe("quote");
      if (outcome.kind !== "quote") throw new Error("expected quote");
      expect(outcome.quote.estimated_total_fen).toBe(1_840_000);
    } finally {
      db.close();
    }
  });

  it("calculates tier coefficients, construction, and conditional surcharges with fixed ordering", () => {
    const db = database();
    try {
      baseSetup(db);
      const tierId = "50000000-0000-4000-8000-000000000041";
      const constructionId = "50000000-0000-4000-8000-000000000042";
      const surchargeId = "50000000-0000-4000-8000-000000000043";
      const tierBaseId = "50000000-0000-4000-8000-000000000044";
      insertRule(db, {
        ruleVersionId: tierBaseId,
        ruleId: "FIXTURE-C05-DESIGN-BASE",
        calculationType: "AREA_MULTIPLY",
        unitPriceFen: 13_750,
        conditions: { scene: "整装" },
      });
      insertRule(db, {
        ruleVersionId: tierId,
        ruleId: "FIXTURE-C05-DESIGN-SENIOR",
        calculationType: "TIER_COEFFICIENT",
        coefficient: 1.5,
        baseRuleId: "FIXTURE-C05-DESIGN-BASE",
        conditions: { designer_tier: "资深", scene: "整装" },
      });
      insertRule(db, {
        ruleVersionId: constructionId,
        ruleId: "FIXTURE-C05-CONSTRUCTION",
        calculationType: "FIXED_AMOUNT",
        amountFen: 200_000,
        conditions: { house_state: "rough" },
      });
      insertRule(db, {
        ruleVersionId: surchargeId,
        ruleId: "FIXTURE-C05-SURCHARGE",
        calculationType: "CONDITIONAL_SURCHARGE",
        amountFen: 50_000,
        conditions: { special_requirement: "静音施工" },
      });
      insertGuardrail(db, tierId, { costRuleRefs: ["FIXTURE-C05-COST-DESIGN"] });
      insertGuardrail(db, constructionId);
      insertGuardrail(db, surchargeId);
      const extendedConfig: QuoteEngineConfig = {
        ...config,
        rule_presentations: {
          ...config.rule_presentations,
          "FIXTURE-C05-SURCHARGE": { label: "静音施工附加服务", category: "surcharge" },
        },
      };
      const candidates = ["FIXTURE-C05-DESIGN-SENIOR", "FIXTURE-C05-CONSTRUCTION", "FIXTURE-C05-SURCHARGE"];
      db.prepare("UPDATE knowledge_evidence SET candidate_rule_ids_json = ? WHERE evidence_id = ?")
        .run(JSON.stringify(candidates), ids.evidence);
      const input = quoteInput();
      const outcome = new DeterministicQuoteEngine(db, extendedConfig).quote({
        ...input,
        request: {
          ...input.request,
          confirmed_parameters: {
            ...input.request.confirmed_parameters,
            designer_tier: "资深",
            special_requirements: ["静音施工"],
          },
          candidate_rule_ids: candidates,
        },
      });
      expect(outcome.kind).toBe("quote");
      if (outcome.kind !== "quote") throw new Error("expected quote");
      expect(outcome.quote.estimated_total_fen).toBe(1_900_000);
      expect(outcome.quote.items.map((item) => item.label)).toEqual([
        "基础施工服务",
        "资深设计服务",
        "静音施工附加服务",
      ]);
    } finally {
      db.close();
    }
  });

  it("asks for a missing designer tier and rejects a mismatched region or scene", () => {
    const db = database();
    try {
      baseSetup(db);
      const base = quoteInput();
      const withoutDesigner = { ...base.request.confirmed_parameters };
      delete withoutDesigner.designer_tier;
      expect(new DeterministicQuoteEngine(db, config).quote({
        ...base,
        request: { ...base.request, confirmed_parameters: withoutDesigner },
      })).toMatchObject({
        kind: "unavailable",
        unavailable: { reason: "missing_fields", missing_fields: ["designer_tier"] },
      });
      expect(new DeterministicQuoteEngine(db, config).quote({
        ...base,
        request: {
          ...base.request,
          confirmed_parameters: { ...base.request.confirmed_parameters, city: "上海" },
        },
      })).toMatchObject({ kind: "unavailable", unavailable: { reason: "rule_not_applicable" } });
      expect(new DeterministicQuoteEngine(db, config).quote({
        ...base,
        request: {
          ...base.request,
          confirmed_parameters: { ...base.request.confirmed_parameters, service_scope: "partial" },
        },
      })).toMatchObject({ kind: "unavailable", unavailable: { reason: "rule_not_applicable" } });
    } finally {
      db.close();
    }
  });

  it("refuses overlapping rules from the same conflict group", () => {
    const db = database();
    try {
      baseSetup(db);
      const conflictId = "50000000-0000-4000-8000-000000000023";
      insertRule(db, {
        ruleVersionId: conflictId,
        ruleId: "FIXTURE-C05-CONFLICT",
        calculationType: "AREA_MULTIPLY",
        unitPriceFen: 14_000,
        conditions: { designer_tier: "标准", scene: "整装" },
        conflictGroup: "DESIGN-ONE",
      });
      db.prepare("UPDATE rule_versions SET conflict_group = 'DESIGN-ONE' WHERE rule_version_id = ?").run(ids.designRule);
      insertGuardrail(db, conflictId);
      db.prepare("UPDATE knowledge_evidence SET candidate_rule_ids_json = ? WHERE evidence_id = ?")
        .run(JSON.stringify(["FIXTURE-C05-DESIGN-STANDARD", "FIXTURE-C05-CONFLICT"]), ids.evidence);
      const input = quoteInput();
      const conflictOutcome = new DeterministicQuoteEngine(db, config).quote({
        ...input,
        request: { ...input.request, candidate_rule_ids: ["FIXTURE-C05-DESIGN-STANDARD", "FIXTURE-C05-CONFLICT"] },
      });
      expect(conflictOutcome).toMatchObject({ kind: "unavailable", unavailable: { reason: "rule_conflict" } });
    } finally {
      db.close();
    }
  });

  it("returns unavailable for missing active rules or insufficient evidence", () => {
    const db = database();
    try {
      baseSetup(db, 0.2);
      expect(new DeterministicQuoteEngine(db, config).quote(quoteInput()))
        .toMatchObject({ kind: "unavailable", unavailable: { reason: "knowledge_insufficient" } });
      db.prepare("UPDATE knowledge_evidence SET score = 0.9").run();
      db.prepare("UPDATE rule_versions SET status = 'inactive' WHERE rule_version_id = ?").run(ids.designRule);
      expect(new DeterministicQuoteEngine(db, config).quote(quoteInput()))
        .toMatchObject({ kind: "unavailable", unavailable: { reason: "no_active_rule" } });
    } finally {
      db.close();
    }
  });

  it("replays an identical request without creating duplicate quote or ledger rows", () => {
    const db = database();
    try {
      baseSetup(db);
      const engine = new DeterministicQuoteEngine(db, config);
      const first = engine.quote(quoteInput());
      const second = engine.quote(quoteInput());
      expect(second).toEqual(first);
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 1 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_internal_calculations").get()).toEqual({ count: 1 });
      const changed = quoteInput();
      changed.request.confirmed_parameters.area_sqm = 81;
      expect(() => engine.quote(changed)).toThrow(/IDEMPOTENCY_KEY_REUSED/);
    } finally {
      db.close();
    }
  });

  it("creates a new child quote version without overwriting history", () => {
    const db = database();
    try {
      baseSetup(db);
      const engine = new DeterministicQuoteEngine(db, config);
      const first = engine.quote(quoteInput());
      if (first.kind !== "quote") throw new Error("expected first quote");
      const secondTurn = "50000000-0000-4000-8000-000000000031";
      const secondMessage = "50000000-0000-4000-8000-000000000032";
      const secondEvidence = "50000000-0000-4000-8000-000000000033";
      db.prepare(`UPDATE turns SET status = 'COMPLETED', outcome = 'quote', completed_at = ?
        WHERE turn_id = ?`).run(at, ids.turn);
      insertConversationAndTurn(db, ids.conversation, secondTurn, secondMessage);
      insertEvidence(db, ["FIXTURE-C05-DESIGN-STANDARD"], secondEvidence, secondTurn);
      const base = quoteInput();
      const second = engine.quote({
        ...base,
        request: {
          ...base.request,
          turn_id: secondTurn,
          parent_quote_id: first.quote.quote_id,
          knowledge_evidence_ids: [secondEvidence],
          confirmed_parameters: { ...base.request.confirmed_parameters, area_sqm: 90 },
        },
      });
      expect(second.kind).toBe("quote");
      if (second.kind !== "quote") throw new Error("expected second quote");
      expect(second.quote).toMatchObject({ quote_version: 2, parent_quote_id: first.quote.quote_id });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 2 });
      expect(engine.getInternalCalculation(first.quote.quote_id).revenue_subtotal_fen).toBe(1_100_000);
    } finally {
      db.close();
    }
  });

  it("rolls back the public quote when internal ledger persistence fails", () => {
    const db = database();
    try {
      baseSetup(db);
      const engine = new DeterministicQuoteEngine(db, config, {
        afterStep(step) {
          if (step === "internal_calculation_saved") throw new Error("injected ledger failure");
        },
      });
      expect(() => engine.quote(quoteInput())).toThrow("injected ledger failure");
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_versions").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_internal_calculations").get()).toEqual({ count: 0 });
      expect(db.prepare("SELECT COUNT(*) AS count FROM quote_items").get()).toEqual({ count: 0 });
    } finally {
      db.close();
    }
  });
});

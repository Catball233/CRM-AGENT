import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  QuoteOutcomeSchema,
  QuoteResultSchema,
  RuleDefinitionSchema,
  type QuoteItem,
  type QuoteOutcome,
  type QuoteParameters,
  type QuoteResult,
} from "@crm-agent/contracts";
import { QuoteVersionRepository } from "@crm-agent/sqlite-repository";
import {
  DeterministicQuoteInputSchema,
  InternalQuoteCalculationSchema,
  QuoteEngineConfigSchema,
  type AppliedPromotionLedger,
  type DeterministicQuoteInput,
  type InternalCostItem,
  type InternalQuoteCalculation,
  type QuoteEngineConfig,
  type QuoteEngineHooks,
  type RulePresentation,
} from "./schemas";

type Row = Record<string, unknown>;
type RuleDefinition = ReturnType<typeof RuleDefinitionSchema.parse>;

interface ActiveRule {
  rule_version_id: string;
  definition: RuleDefinition;
  effective_to: string | null;
}

interface Guardrail {
  minimum_margin_bps: number;
  maximum_discount_bps: number;
  cost_rule_refs: string[];
  supplier_quote_snapshot_refs: string[];
  gift_cost_fen: number;
  free_service_cost_fen: number;
}

interface CalculatedRule {
  rule: ActiveRule;
  amount_fen: number;
  quantity?: number;
  unit_price_fen?: number;
  calculation_inputs: Record<string, string | number | boolean>;
}

interface PromotionRow {
  promotion_rule_version_id: string;
  promotion_id: string;
  benefit_type: "cash_discount" | "gift" | "free_service";
  discount_bps: number | null;
  benefit_cost_fen: number;
  priority: number;
  exclusion_group: string | null;
  stackable: boolean;
  effective_to: string | null;
}

const MAX_SAFE_MONEY = BigInt(Number.MAX_SAFE_INTEGER);

function stringValue(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function numberValue(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number") throw new Error(`Invalid ${key} in SQLite row`);
  return value;
}

function nullableString(row: Row, key: string): string | null {
  const value = row[key];
  if (value === null) return null;
  return stringValue(row, key);
}

function nullableNumber(row: Row, key: string): number | null {
  const value = row[key];
  if (value === null) return null;
  return numberValue(row, key);
}

function parseJson<T>(row: Row, key: string): T {
  try {
    return JSON.parse(stringValue(row, key)) as T;
  } catch (error) {
    throw new Error(`Invalid JSON in ${key}`, { cause: error });
  }
}

function transaction<T>(database: DatabaseSync, action: () => T): T {
  if (database.isTransaction) return action();
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function safeMoney(value: bigint, field: string): number {
  if (value < 0n || value > MAX_SAFE_MONEY) throw new Error(`${field} exceeds safe money range`);
  return Number(value);
}

function sumMoney(values: number[], field: string): number {
  return safeMoney(values.reduce((total, value) => total + BigInt(value), 0n), field);
}

function decimalFraction(value: number): { numerator: bigint; denominator: bigint } {
  if (!Number.isFinite(value) || value < 0) throw new Error("quantity must be a finite nonnegative number");
  const text = value.toString().toLowerCase();
  const [coefficient = "0", exponentText] = text.split("e");
  const exponent = exponentText ? Number(exponentText) : 0;
  const [whole = "0", fraction = ""] = coefficient.split(".");
  const digits = BigInt(`${whole}${fraction}` || "0");
  const scale = fraction.length - exponent;
  return scale <= 0
    ? { numerator: digits * (10n ** BigInt(-scale)), denominator: 1n }
    : { numerator: digits, denominator: 10n ** BigInt(scale) };
}

function multiplyMoneyHalfUp(amountFen: number, multiplier: number, field: string): number {
  const fraction = decimalFraction(multiplier);
  const numerator = BigInt(amountFen) * fraction.numerator;
  return safeMoney((numerator * 2n + fraction.denominator) / (fraction.denominator * 2n), field);
}

function floorBasisPoints(amountFen: number, basisPoints: number): number {
  return safeMoney(BigInt(amountFen) * BigInt(basisPoints) / 10_000n, "basis point calculation");
}

export function floorRevenueFen(totalCostFen: number, minimumMarginBps: number): number {
  const denominator = BigInt(10_000 - minimumMarginBps);
  if (denominator <= 0n) throw new Error("minimum margin produces an invalid denominator");
  const numerator = BigInt(totalCostFen) * 10_000n;
  return safeMoney((numerator + denominator - 1n) / denominator, "floor revenue");
}

function requestHash(input: ReturnType<typeof DeterministicQuoteInputSchema.parse>): string {
  return createHash("sha256").update(JSON.stringify(input)).digest("hex");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function earliestTimestamp(values: string[]): string {
  return values.reduce((earliest, value) => Date.parse(value) < Date.parse(earliest) ? value : earliest);
}

export class DeterministicQuoteEngine {
  private readonly config: ReturnType<typeof QuoteEngineConfigSchema.parse>;

  constructor(
    private readonly database: DatabaseSync,
    config: QuoteEngineConfig,
    private readonly hooks?: QuoteEngineHooks,
  ) {
    this.config = QuoteEngineConfigSchema.parse(config);
  }

  quote(input: DeterministicQuoteInput): QuoteOutcome {
    const parsed = DeterministicQuoteInputSchema.parse(input);
    const hash = requestHash(parsed);
    const replay = this.findReplay(parsed.request.turn_id, hash, parsed.request.conversation_id);
    if (replay) return { kind: "quote", quote: replay };

    const evidenceOutcome = this.validateEvidence(parsed);
    if (evidenceOutcome) return evidenceOutcome;

    const candidateRules: ActiveRule[] = [];
    const unavailableRuleIds: string[] = [];
    for (const ruleId of unique(parsed.request.candidate_rule_ids).sort()) {
      const rule = this.loadActiveRule(ruleId, parsed.request.requested_at);
      if (rule) candidateRules.push(rule);
      else unavailableRuleIds.push(ruleId);
    }
    if (unavailableRuleIds.length > 0 || candidateRules.length === 0) {
      return this.unavailable("no_active_rule", [], []);
    }

    const conflicts = this.conflictingRuleIds(candidateRules);
    if (conflicts.length > 0) return this.unavailable("rule_conflict", [], conflicts);

    const missingFields = this.missingFields(candidateRules, parsed.request.confirmed_parameters);
    if (missingFields.length > 0) return this.unavailable("missing_fields", missingFields, []);
    if (candidateRules.some((rule) => !this.ruleApplies(rule, parsed.request.confirmed_parameters))) {
      return this.unavailable("rule_not_applicable", [], []);
    }
    if (candidateRules.some((rule) => !this.config.rule_presentations[rule.definition.rule_id])) {
      return this.unavailable("rule_not_applicable", [], []);
    }

    const calculationCache = new Map<string, CalculatedRule>();
    const calculationStack = new Set<string>();
    const nonMinimumRules = candidateRules
      .filter((rule) => rule.definition.calculation_type !== "MINIMUM_PRICE")
      .sort((left, right) => left.definition.rule_id.localeCompare(right.definition.rule_id));
    const minimumRules = candidateRules
      .filter((rule) => rule.definition.calculation_type === "MINIMUM_PRICE")
      .sort((left, right) => left.definition.rule_id.localeCompare(right.definition.rule_id));
    let grossCalculations: CalculatedRule[];
    try {
      grossCalculations = nonMinimumRules.map((rule) => this.calculateRule(
        rule,
        parsed.request.confirmed_parameters,
        parsed.request.requested_at,
        calculationCache,
        calculationStack,
      ));
      let subtotal = sumMoney(grossCalculations.map((calculation) => calculation.amount_fen), "quote subtotal");
      for (const rule of minimumRules) {
        const minimum = rule.definition.minimum_price_fen ?? 0;
        const calculation: CalculatedRule = {
          rule,
          amount_fen: Math.max(0, minimum - subtotal),
          calculation_inputs: { minimum_price_fen: minimum, subtotal_before_minimum_fen: subtotal },
        };
        grossCalculations.push(calculation);
        subtotal = sumMoney([subtotal, calculation.amount_fen], "minimum adjusted subtotal");
        calculationCache.set(rule.definition.rule_id, calculation);
      }
    } catch {
      return this.unavailable("rule_not_applicable", [], []);
    }
    const revenueSubtotalFen = sumMoney(grossCalculations.map((entry) => entry.amount_fen), "revenue subtotal");

    const internalRuleRefs = new Map<string, { rule_id: string; rule_version_id: string; version: number }>();
    for (const calculation of calculationCache.values()) {
      internalRuleRefs.set(calculation.rule.rule_version_id, {
        rule_id: calculation.rule.definition.rule_id,
        rule_version_id: calculation.rule.rule_version_id,
        version: calculation.rule.definition.version,
      });
    }
    const costItems: InternalCostItem[] = [];
    const supplierSnapshotRefs = new Set<string>();
    const guardrails: Guardrail[] = [];
    let validityCandidates = [
      new Date(Date.parse(parsed.request.requested_at) + this.config.quote_validity_seconds * 1_000).toISOString(),
      ...candidateRules.flatMap((rule) => rule.effective_to ? [rule.effective_to] : []),
    ];

    for (const rule of candidateRules) {
      const guardrail = this.loadGuardrail(rule.rule_version_id);
      if (!guardrail) return this.unavailable("rule_not_applicable", [], []);
      guardrails.push(guardrail);
      if (guardrail.gift_cost_fen > 0) costItems.push(this.costItem("gift", guardrail.gift_cost_fen, rule.definition.rule_id, rule.rule_version_id));
      if (guardrail.free_service_cost_fen > 0) costItems.push(this.costItem("free_service", guardrail.free_service_cost_fen, rule.definition.rule_id, rule.rule_version_id));
      for (const costRuleId of guardrail.cost_rule_refs) {
        if (costItems.some((item) => item.cost_type === "direct_rule" && item.source_ref === costRuleId)) continue;
        const costRule = this.loadActiveRule(costRuleId, parsed.request.requested_at);
        if (!costRule || !this.ruleApplies(costRule, parsed.request.confirmed_parameters)) {
          return this.unavailable("no_active_rule", [], []);
        }
        try {
          const cost = this.calculateRule(
            costRule,
            parsed.request.confirmed_parameters,
            parsed.request.requested_at,
            calculationCache,
            calculationStack,
          );
          internalRuleRefs.set(costRule.rule_version_id, {
            rule_id: costRule.definition.rule_id,
            rule_version_id: costRule.rule_version_id,
            version: costRule.definition.version,
          });
          costItems.push(this.costItem("direct_rule", cost.amount_fen, costRuleId, costRule.rule_version_id));
          if (costRule.effective_to) validityCandidates.push(costRule.effective_to);
        } catch {
          return this.unavailable("rule_not_applicable", [], []);
        }
      }
      for (const snapshotId of guardrail.supplier_quote_snapshot_refs) {
        if (supplierSnapshotRefs.has(snapshotId)) continue;
        const snapshot = this.database.prepare(`SELECT * FROM supplier_quote_snapshots
          WHERE supplier_quote_snapshot_id = ? AND currency = 'CNY' AND region = ?
            AND datetime(valid_from) <= datetime(?) AND datetime(valid_to) > datetime(?)`)
          .get(snapshotId, parsed.request.confirmed_parameters.city, parsed.request.requested_at, parsed.request.requested_at) as Row | undefined;
        if (!snapshot) return this.unavailable("rule_not_applicable", [], []);
        supplierSnapshotRefs.add(snapshotId);
        validityCandidates.push(stringValue(snapshot, "valid_to"));
        const items = parseJson<Array<{
          item_ref: string;
          quantity: number;
          wholesale_cost_fen: number;
          delivery_cost_fen: number;
          installation_cost_fen: number;
          warranty_cost_fen: number;
        }>>(snapshot, "items_json");
        for (const item of items) {
          const components = [
            ["procurement_wholesale", item.wholesale_cost_fen],
            ["delivery", item.delivery_cost_fen],
            ["installation", item.installation_cost_fen],
            ["warranty", item.warranty_cost_fen],
          ] as const;
          for (const [costType, unitCost] of components) {
            if (unitCost <= 0) continue;
            costItems.push(this.costItem(
              costType,
              multiplyMoneyHalfUp(unitCost, item.quantity, `${costType} cost`),
              item.item_ref,
              undefined,
              snapshotId,
            ));
          }
        }
      }
    }

    const promotions = this.selectPromotions(parsed, revenueSubtotalFen);
    if (parsed.promotion_required && promotions.length === 0) {
      return this.unavailable("rule_not_applicable", [], []);
    }
    const promotionLedger: AppliedPromotionLedger[] = [];
    let approvedDiscountFen = 0;
    for (const promotion of promotions) {
      if (promotion.effective_to) validityCandidates.push(promotion.effective_to);
      const discount = promotion.benefit_type === "cash_discount"
        ? floorBasisPoints(revenueSubtotalFen, promotion.discount_bps ?? 0)
        : 0;
      approvedDiscountFen = sumMoney([approvedDiscountFen, discount], "promotion discount");
      if (promotion.benefit_type === "gift" && promotion.benefit_cost_fen > 0) {
        costItems.push(this.costItem("gift", promotion.benefit_cost_fen, promotion.promotion_id));
      }
      if (promotion.benefit_type === "free_service" && promotion.benefit_cost_fen > 0) {
        costItems.push(this.costItem("free_service", promotion.benefit_cost_fen, promotion.promotion_id));
      }
      promotionLedger.push({
        promotion_rule_version_id: promotion.promotion_rule_version_id,
        promotion_id: promotion.promotion_id,
        approved_discount_fen: discount,
        internal_benefit_cost_fen: promotion.benefit_cost_fen,
      });
    }

    const directCostFen = sumMoney(costItems.filter((item) => item.cost_type === "direct_rule").map((item) => item.amount_fen), "direct cost");
    const procurementCostFen = sumMoney(costItems.filter((item) => [
      "procurement_wholesale", "delivery", "installation", "warranty",
    ].includes(item.cost_type)).map((item) => item.amount_fen), "procurement cost");
    const giftCostFen = sumMoney(costItems.filter((item) => item.cost_type === "gift").map((item) => item.amount_fen), "gift cost");
    const freeServiceCostFen = sumMoney(costItems.filter((item) => item.cost_type === "free_service").map((item) => item.amount_fen), "free service cost");
    const totalCostFen = sumMoney([directCostFen, procurementCostFen, giftCostFen, freeServiceCostFen], "total cost");
    const minimumMarginBps = Math.max(...guardrails.map((guardrail) => guardrail.minimum_margin_bps));
    const maximumDiscountBps = Math.min(...guardrails.map((guardrail) => guardrail.maximum_discount_bps));
    let floorRevenue: number;
    try {
      floorRevenue = floorRevenueFen(totalCostFen, minimumMarginBps);
    } catch {
      return this.unavailable("rule_not_applicable", [], []);
    }
    const ruleDiscountCapFen = floorBasisPoints(revenueSubtotalFen, maximumDiscountBps);
    const marginHeadroomFen = Math.max(0, revenueSubtotalFen - floorRevenue);
    const maximumAllowedDiscountFen = Math.min(ruleDiscountCapFen, marginHeadroomFen);
    const finalRevenueFen = revenueSubtotalFen - approvedDiscountFen;
    if (
      approvedDiscountFen > maximumAllowedDiscountFen
      || finalRevenueFen < totalCostFen
      || finalRevenueFen < floorRevenue
    ) {
      return this.unavailable("rule_not_applicable", [], []);
    }

    const quoteItems = this.customerItems(grossCalculations, approvedDiscountFen);
    const customerRuleVersions = unique(quoteItems.map((item) => item.rule_ref.rule_version_id))
      .map((versionId) => quoteItems.find((item) => item.rule_ref.rule_version_id === versionId)?.rule_ref)
      .filter((value): value is QuoteItem["rule_ref"] => Boolean(value));
    const quoteRepository = new QuoteVersionRepository(this.database);
    const quoteId = randomUUID();
    const quoteVersion = quoteRepository.nextVersion(parsed.request.conversation_id);
    const validUntil = earliestTimestamp(validityCandidates);
    const quote = QuoteResultSchema.parse({
      contract_version: "1.0.0",
      quote_id: quoteId,
      conversation_id: parsed.request.conversation_id,
      quote_version: quoteVersion,
      parent_quote_id: parsed.request.parent_quote_id ?? null,
      status: "estimated",
      currency: "CNY",
      parameters_snapshot: parsed.request.confirmed_parameters,
      items: quoteItems,
      estimated_total_fen: finalRevenueFen,
      rule_versions: customerRuleVersions,
      knowledge_evidence_ids: unique(parsed.request.knowledge_evidence_ids).sort(),
      assumptions: this.config.assumptions,
      exclusions: this.config.exclusions,
      disclaimer: this.config.disclaimer,
      created_at: parsed.request.requested_at,
    });
    const internal = InternalQuoteCalculationSchema.parse({
      calculation_id: randomUUID(),
      quote_id: quoteId,
      turn_id: parsed.request.turn_id,
      request_hash: hash,
      quote_version: quoteVersion,
      revenue_subtotal_fen: revenueSubtotalFen,
      direct_cost_fen: directCostFen,
      procurement_cost_fen: procurementCostFen,
      gift_cost_fen: giftCostFen,
      free_service_cost_fen: freeServiceCostFen,
      total_cost_fen: totalCostFen,
      minimum_margin_bps: minimumMarginBps,
      floor_revenue_fen: floorRevenue,
      rule_discount_cap_fen: ruleDiscountCapFen,
      margin_headroom_fen: marginHeadroomFen,
      approved_discount_fen: approvedDiscountFen,
      final_revenue_fen: finalRevenueFen,
      intent_level: parsed.intent_level,
      supplier_snapshot_refs: [...supplierSnapshotRefs].sort(),
      rule_version_refs: [...internalRuleRefs.values()].sort((left, right) => left.rule_id.localeCompare(right.rule_id)),
      knowledge_evidence_ids: unique(parsed.request.knowledge_evidence_ids).sort(),
      cost_items: costItems,
      applied_promotions: promotionLedger,
      validation_codes: ["ACTIVE_RULES_ONLY", "EVIDENCE_VERIFIED", "PROFIT_FLOOR_VERIFIED"],
      valid_until: validUntil,
      calculated_at: parsed.request.requested_at,
    });

    return transaction(this.database, () => {
      quoteRepository.save({ turn_id: parsed.request.turn_id, quote });
      this.hooks?.afterStep?.("quote_saved");
      this.insertInternalCalculation(internal);
      this.hooks?.afterStep?.("internal_calculation_saved");
      for (const item of internal.cost_items) this.insertCostItem(quoteId, item);
      this.hooks?.afterStep?.("cost_items_saved");
      for (const promotion of internal.applied_promotions) {
        this.database.prepare(`INSERT INTO quote_promotion_links (
          quote_id, promotion_rule_version_id, approved_discount_fen, internal_benefit_cost_fen
        ) VALUES (?, ?, ?, ?)`)
          .run(
            quoteId, promotion.promotion_rule_version_id,
            promotion.approved_discount_fen, promotion.internal_benefit_cost_fen,
          );
      }
      this.hooks?.afterStep?.("promotions_saved");
      return QuoteOutcomeSchema.parse({ kind: "quote", quote: quoteRepository.get(quote.conversation_id, quoteId) });
    });
  }

  getInternalCalculation(quoteId: string): InternalQuoteCalculation {
    const row = this.database.prepare(`SELECT qic.*, qv.quote_version FROM quote_internal_calculations qic
      JOIN quote_versions qv USING (quote_id) WHERE qic.quote_id = ?`).get(quoteId) as Row | undefined;
    if (!row) throw new Error("internal quote calculation was not found");
    const costRows = this.database.prepare("SELECT * FROM quote_internal_cost_items WHERE quote_id = ? ORDER BY cost_item_id")
      .all(quoteId) as Row[];
    const promotionRows = this.database.prepare(`SELECT qpl.*, prv.promotion_id
      FROM quote_promotion_links qpl JOIN promotion_rule_versions prv USING (promotion_rule_version_id)
      WHERE qpl.quote_id = ? ORDER BY prv.promotion_id`).all(quoteId) as Row[];
    return InternalQuoteCalculationSchema.parse({
      calculation_id: stringValue(row, "calculation_id"),
      quote_id: stringValue(row, "quote_id"),
      turn_id: stringValue(row, "turn_id"),
      request_hash: stringValue(row, "request_hash"),
      quote_version: numberValue(row, "quote_version"),
      revenue_subtotal_fen: numberValue(row, "revenue_subtotal_fen"),
      direct_cost_fen: numberValue(row, "direct_cost_fen"),
      procurement_cost_fen: numberValue(row, "procurement_cost_fen"),
      gift_cost_fen: numberValue(row, "gift_cost_fen"),
      free_service_cost_fen: numberValue(row, "free_service_cost_fen"),
      total_cost_fen: numberValue(row, "total_cost_fen"),
      minimum_margin_bps: numberValue(row, "minimum_margin_bps"),
      floor_revenue_fen: numberValue(row, "floor_revenue_fen"),
      rule_discount_cap_fen: numberValue(row, "rule_discount_cap_fen"),
      margin_headroom_fen: numberValue(row, "margin_headroom_fen"),
      approved_discount_fen: numberValue(row, "approved_discount_fen"),
      final_revenue_fen: numberValue(row, "final_revenue_fen"),
      intent_level: stringValue(row, "intent_level"),
      supplier_snapshot_refs: parseJson(row, "supplier_snapshot_refs_json"),
      rule_version_refs: parseJson(row, "rule_version_refs_json"),
      knowledge_evidence_ids: parseJson(row, "knowledge_evidence_ids_json"),
      validation_codes: parseJson(row, "validation_codes_json"),
      valid_until: stringValue(row, "valid_until"),
      calculated_at: stringValue(row, "calculated_at"),
      cost_items: costRows.map((cost) => ({
        cost_item_id: stringValue(cost, "cost_item_id"),
        cost_type: stringValue(cost, "cost_type"),
        amount_fen: numberValue(cost, "amount_fen"),
        source_ref: stringValue(cost, "source_ref"),
        ...(cost.rule_version_id === null ? {} : { rule_version_id: stringValue(cost, "rule_version_id") }),
        ...(cost.supplier_quote_snapshot_id === null ? {} : {
          supplier_quote_snapshot_id: stringValue(cost, "supplier_quote_snapshot_id"),
        }),
      })),
      applied_promotions: promotionRows.map((promotion) => ({
        promotion_rule_version_id: stringValue(promotion, "promotion_rule_version_id"),
        promotion_id: stringValue(promotion, "promotion_id"),
        approved_discount_fen: numberValue(promotion, "approved_discount_fen"),
        internal_benefit_cost_fen: numberValue(promotion, "internal_benefit_cost_fen"),
      })),
    });
  }

  private findReplay(turnId: string, hash: string, conversationId: string): QuoteResult | null {
    const row = this.database.prepare(`SELECT quote_id, request_hash FROM quote_internal_calculations WHERE turn_id = ?`)
      .get(turnId) as Row | undefined;
    if (!row) return null;
    if (stringValue(row, "request_hash") !== hash) throw new Error("IDEMPOTENCY_KEY_REUSED: quote request changed");
    return new QuoteVersionRepository(this.database).get(conversationId, stringValue(row, "quote_id"));
  }

  private validateEvidence(input: ReturnType<typeof DeterministicQuoteInputSchema.parse>): QuoteOutcome | null {
    const evidenceRows = input.request.knowledge_evidence_ids.map((evidenceId) => this.database.prepare(`SELECT *
      FROM knowledge_evidence WHERE evidence_id = ? AND conversation_id = ? AND turn_id = ?`)
      .get(evidenceId, input.request.conversation_id, input.request.turn_id) as Row | undefined);
    if (evidenceRows.some((row) => !row || numberValue(row, "score") < this.config.minimum_evidence_score)) {
      return this.unavailable("knowledge_insufficient", [], []);
    }
    for (const ruleId of input.request.candidate_rule_ids) {
      if (!evidenceRows.some((row) => row && parseJson<string[]>(row, "candidate_rule_ids_json").includes(ruleId))) {
        return this.unavailable("knowledge_insufficient", [], []);
      }
    }
    return null;
  }

  private loadActiveRule(ruleId: string, effectiveAt: string): ActiveRule | null {
    const row = this.database.prepare(`SELECT * FROM rule_versions WHERE rule_id = ? AND status = 'active'
      AND datetime(effective_from) <= datetime(?)
      AND (effective_to IS NULL OR datetime(effective_to) > datetime(?))`)
      .get(ruleId, effectiveAt, effectiveAt) as Row | undefined;
    if (!row) return null;
    return {
      rule_version_id: stringValue(row, "rule_version_id"),
      effective_to: nullableString(row, "effective_to"),
      definition: RuleDefinitionSchema.parse({
        rule_id: stringValue(row, "rule_id"),
        version: numberValue(row, "version"),
        city: stringValue(row, "city"),
        calculation_type: stringValue(row, "calculation_type"),
        ...(row.amount_fen === null ? {} : { amount_fen: numberValue(row, "amount_fen") }),
        ...(row.unit_price_fen === null ? {} : { unit_price_fen: numberValue(row, "unit_price_fen") }),
        ...(row.coefficient === null ? {} : { coefficient: numberValue(row, "coefficient") }),
        ...(row.base_rule_id === null ? {} : { base_rule_id: stringValue(row, "base_rule_id") }),
        ...(row.minimum_price_fen === null ? {} : { minimum_price_fen: numberValue(row, "minimum_price_fen") }),
        conditions: parseJson(row, "conditions_json"),
        ...(row.conflict_group === null ? {} : { conflict_group: stringValue(row, "conflict_group") }),
        effective_from: stringValue(row, "effective_from"),
        ...(row.effective_to === null ? {} : { effective_to: stringValue(row, "effective_to") }),
      }),
    };
  }

  private loadGuardrail(ruleVersionId: string): Guardrail | null {
    const row = this.database.prepare("SELECT * FROM rule_guardrails WHERE rule_version_id = ?")
      .get(ruleVersionId) as Row | undefined;
    return row ? {
      minimum_margin_bps: numberValue(row, "minimum_margin_bps"),
      maximum_discount_bps: numberValue(row, "maximum_discount_bps"),
      cost_rule_refs: parseJson(row, "cost_rule_refs_json"),
      supplier_quote_snapshot_refs: parseJson(row, "supplier_quote_snapshot_refs_json"),
      gift_cost_fen: numberValue(row, "gift_cost_fen"),
      free_service_cost_fen: numberValue(row, "free_service_cost_fen"),
    } : null;
  }

  private conflictingRuleIds(rules: ActiveRule[]): string[] {
    const groups = new Map<string, string[]>();
    for (const rule of rules) {
      const group = rule.definition.conflict_group;
      if (group) groups.set(group, [...(groups.get(group) ?? []), rule.definition.rule_id]);
    }
    return [...groups.values()].filter((ids) => ids.length > 1).flat().sort();
  }

  private missingFields(rules: ActiveRule[], parameters: QuoteParameters): Array<"designer_tier" | "quantities"> {
    const missing = new Set<"designer_tier" | "quantities">();
    for (const rule of rules) {
      if (typeof rule.definition.conditions.designer_tier === "string" && !parameters.designer_tier) {
        missing.add("designer_tier");
      }
      if (rule.definition.calculation_type === "QUANTITY_MULTIPLY") {
        const presentation = this.config.rule_presentations[rule.definition.rule_id];
        const key = presentation?.quantity_key;
        if (!key || parameters.quantities[key] === undefined) missing.add("quantities");
      }
    }
    return [...missing];
  }

  private ruleApplies(rule: ActiveRule, parameters: QuoteParameters): boolean {
    if (rule.definition.city !== parameters.city) return false;
    const conditions = rule.definition.conditions;
    const scene = parameters.service_scope === "whole_home" ? "整装"
      : parameters.service_scope === "partial" ? "局部翻新" : "设计专项";
    const comparisons: Record<string, string | undefined> = {
      house_state: parameters.house_state,
      service_scope: parameters.service_scope,
      scene,
      material_tier: parameters.material_tier,
      designer_tier: parameters.designer_tier,
    };
    for (const [key, actual] of Object.entries(comparisons)) {
      const expected = conditions[key];
      if (expected !== undefined && expected !== actual) return false;
    }
    const minimumArea = conditions.min_area_sqm;
    const maximumArea = conditions.max_area_sqm;
    if (typeof minimumArea === "number" && parameters.area_sqm < minimumArea) return false;
    if (typeof maximumArea === "number" && parameters.area_sqm > maximumArea) return false;
    const requirement = conditions.special_requirement;
    if (typeof requirement === "string" && !parameters.special_requirements.includes(requirement)) return false;
    return true;
  }

  private calculateRule(
    rule: ActiveRule,
    parameters: QuoteParameters,
    effectiveAt: string,
    cache: Map<string, CalculatedRule>,
    stack: Set<string>,
  ): CalculatedRule {
    const cached = cache.get(rule.definition.rule_id);
    if (cached) return cached;
    if (stack.has(rule.definition.rule_id)) throw new Error("cyclic rule dependency");
    stack.add(rule.definition.rule_id);
    const presentation = this.config.rule_presentations[rule.definition.rule_id];
    let result: CalculatedRule;
    switch (rule.definition.calculation_type) {
      case "FIXED_AMOUNT":
      case "CONDITIONAL_SURCHARGE":
        result = {
          rule,
          amount_fen: rule.definition.amount_fen ?? 0,
          calculation_inputs: { fixed_amount_fen: rule.definition.amount_fen ?? 0 },
        };
        break;
      case "AREA_MULTIPLY":
        const areaUnitPriceFen = rule.definition.unit_price_fen ?? 0;
        result = {
          rule,
          amount_fen: multiplyMoneyHalfUp(areaUnitPriceFen, parameters.area_sqm, "area amount"),
          quantity: parameters.area_sqm,
          unit_price_fen: areaUnitPriceFen,
          calculation_inputs: { area_sqm: parameters.area_sqm },
        };
        break;
      case "QUANTITY_MULTIPLY": {
        const key = presentation?.quantity_key;
        if (!key) throw new Error("quantity rule presentation is missing quantity_key");
        const quantity = parameters.quantities[key];
        if (quantity === undefined) throw new Error("quantity was not confirmed");
        const quantityUnitPriceFen = rule.definition.unit_price_fen ?? 0;
        result = {
          rule,
          amount_fen: multiplyMoneyHalfUp(quantityUnitPriceFen, quantity, "quantity amount"),
          quantity,
          unit_price_fen: quantityUnitPriceFen,
          calculation_inputs: { quantity_key: key, quantity },
        };
        break;
      }
      case "TIER_COEFFICIENT": {
        const baseRuleId = rule.definition.base_rule_id;
        if (!baseRuleId) throw new Error("tier rule is missing base_rule_id");
        const baseRule = this.loadActiveRule(baseRuleId, effectiveAt);
        if (!baseRule || !this.ruleApplies(baseRule, parameters)) throw new Error("tier base rule is unavailable");
        const base = this.calculateRule(baseRule, parameters, effectiveAt, cache, stack);
        result = {
          rule,
          amount_fen: multiplyMoneyHalfUp(base.amount_fen, rule.definition.coefficient ?? 1, "tier amount"),
          calculation_inputs: {
            base_rule_id: baseRuleId,
            base_amount_fen: base.amount_fen,
            coefficient: rule.definition.coefficient ?? 1,
          },
        };
        break;
      }
      case "MINIMUM_PRICE":
        throw new Error("minimum price is calculated after subtotal");
    }
    stack.delete(rule.definition.rule_id);
    cache.set(rule.definition.rule_id, result);
    return result;
  }

  private selectPromotions(
    input: ReturnType<typeof DeterministicQuoteInputSchema.parse>,
    subtotalFen: number,
  ): PromotionRow[] {
    if (input.candidate_promotion_ids.length === 0 && !["low", "medium"].includes(input.intent_level)) return [];
    const rows = this.database.prepare(`SELECT * FROM promotion_rule_versions
      WHERE status = 'active' AND city = ?
        AND datetime(effective_from) <= datetime(?)
        AND (effective_to IS NULL OR datetime(effective_to) > datetime(?))
        AND minimum_subtotal_fen <= ?`)
      .all(
        input.request.confirmed_parameters.city,
        input.request.requested_at,
        input.request.requested_at,
        subtotalFen,
      ) as Row[];
    const requested = new Set(input.candidate_promotion_ids);
    const candidates = rows.filter((row) => {
      const allowedIntent = parseJson<string[]>(row, "intent_levels_json").includes(input.intent_level);
      const requestedMatch = requested.size === 0 || requested.has(stringValue(row, "promotion_id"));
      return allowedIntent && requestedMatch;
    }).map((row): PromotionRow => ({
      promotion_rule_version_id: stringValue(row, "promotion_rule_version_id"),
      promotion_id: stringValue(row, "promotion_id"),
      benefit_type: stringValue(row, "benefit_type") as PromotionRow["benefit_type"],
      discount_bps: nullableNumber(row, "discount_bps"),
      benefit_cost_fen: numberValue(row, "benefit_cost_fen"),
      priority: numberValue(row, "priority"),
      exclusion_group: nullableString(row, "exclusion_group"),
      stackable: numberValue(row, "stackable") === 1,
      effective_to: nullableString(row, "effective_to"),
    })).sort((left, right) => left.priority - right.priority || left.promotion_id.localeCompare(right.promotion_id));

    const selected: PromotionRow[] = [];
    const exclusionGroups = new Set<string>();
    for (const candidate of candidates) {
      if (candidate.exclusion_group && exclusionGroups.has(candidate.exclusion_group)) continue;
      if (selected.length > 0 && (!candidate.stackable || selected.some((entry) => !entry.stackable))) continue;
      selected.push(candidate);
      if (candidate.exclusion_group) exclusionGroups.add(candidate.exclusion_group);
    }
    return selected;
  }

  private customerItems(calculations: CalculatedRule[], totalDiscountFen: number): QuoteItem[] {
    let remainingDiscount = totalDiscountFen;
    return calculations.map((calculation) => {
      const allocated = Math.min(calculation.amount_fen, remainingDiscount);
      remainingDiscount -= allocated;
      const presentation = this.config.rule_presentations[calculation.rule.definition.rule_id] as RulePresentation;
      return {
        quote_item_id: randomUUID(),
        category: presentation.category,
        label: presentation.label,
        calculation_type: calculation.rule.definition.calculation_type,
        ...(calculation.quantity === undefined ? {} : { quantity: calculation.quantity }),
        ...(presentation.unit ? { unit: presentation.unit } : {}),
        ...(calculation.unit_price_fen === undefined ? {} : { unit_price_fen: calculation.unit_price_fen }),
        amount_fen: calculation.amount_fen - allocated,
        calculation_inputs: {
          ...calculation.calculation_inputs,
          gross_amount_fen: calculation.amount_fen,
          discount_allocated_fen: allocated,
        },
        rule_ref: {
          rule_id: calculation.rule.definition.rule_id,
          rule_version_id: calculation.rule.rule_version_id,
          version: calculation.rule.definition.version,
        },
      };
    });
  }

  private costItem(
    costType: InternalCostItem["cost_type"],
    amountFen: number,
    sourceRef: string,
    ruleVersionId?: string,
    supplierSnapshotId?: string,
  ): InternalCostItem {
    return {
      cost_item_id: randomUUID(),
      cost_type: costType,
      amount_fen: amountFen,
      source_ref: sourceRef,
      ...(ruleVersionId ? { rule_version_id: ruleVersionId } : {}),
      ...(supplierSnapshotId ? { supplier_quote_snapshot_id: supplierSnapshotId } : {}),
    };
  }

  private insertInternalCalculation(internal: InternalQuoteCalculation): void {
    this.database.prepare(`INSERT INTO quote_internal_calculations (
      calculation_id, quote_id, turn_id, request_hash, revenue_subtotal_fen, direct_cost_fen,
      procurement_cost_fen, gift_cost_fen, free_service_cost_fen, total_cost_fen,
      minimum_margin_bps, floor_revenue_fen, rule_discount_cap_fen, margin_headroom_fen,
      approved_discount_fen, final_revenue_fen, intent_level, supplier_snapshot_refs_json,
      rule_version_refs_json, knowledge_evidence_ids_json, validation_codes_json, valid_until, calculated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(
        internal.calculation_id, internal.quote_id, internal.turn_id, internal.request_hash,
        internal.revenue_subtotal_fen, internal.direct_cost_fen, internal.procurement_cost_fen,
        internal.gift_cost_fen, internal.free_service_cost_fen, internal.total_cost_fen,
        internal.minimum_margin_bps, internal.floor_revenue_fen, internal.rule_discount_cap_fen,
        internal.margin_headroom_fen, internal.approved_discount_fen, internal.final_revenue_fen,
        internal.intent_level, JSON.stringify(internal.supplier_snapshot_refs),
        JSON.stringify(internal.rule_version_refs), JSON.stringify(internal.knowledge_evidence_ids),
        JSON.stringify(internal.validation_codes), internal.valid_until, internal.calculated_at,
      );
  }

  private insertCostItem(quoteId: string, item: InternalCostItem): void {
    this.database.prepare(`INSERT INTO quote_internal_cost_items (
      cost_item_id, quote_id, cost_type, amount_fen, source_ref, rule_version_id, supplier_quote_snapshot_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(
        item.cost_item_id, quoteId, item.cost_type, item.amount_fen, item.source_ref,
        item.rule_version_id ?? null, item.supplier_quote_snapshot_id ?? null,
      );
  }

  private unavailable(
    reason: "missing_fields" | "knowledge_insufficient" | "no_active_rule" | "rule_not_applicable" | "rule_conflict",
    missingFields: Array<"designer_tier" | "quantities">,
    conflictingRuleIds: string[],
  ): QuoteOutcome {
    const message = reason === "missing_fields"
      ? "请补充必要的报价信息后再试。"
      : reason === "knowledge_insufficient"
        ? "当前依据不足，暂时无法生成可靠报价。"
        : reason === "rule_not_applicable"
          ? "当前调整无法应用，可调整方案后再试。"
          : "当前暂时无法生成可靠报价，请稍后重试。";
    return QuoteOutcomeSchema.parse({
      kind: "unavailable",
      unavailable: {
        contract_version: "1.0.0",
        reason,
        missing_fields: missingFields,
        conflicting_rule_ids: conflictingRuleIds,
        user_safe_message: message,
      },
    });
  }
}

import { z } from "zod";
import {
  IdSchema,
  IntentLevelSchema,
  IsoDateTimeSchema,
  MoneyFenSchema,
  QuoteRequestSchema,
  RuleVersionRefSchema,
} from "@crm-agent/contracts";

export const DeterministicQuoteInputSchema = z.object({
  request: QuoteRequestSchema,
  intent_level: IntentLevelSchema,
  candidate_promotion_ids: z.array(z.string().min(1).max(100)).max(100).default([]),
  promotion_required: z.boolean().default(false),
}).strict();
export type DeterministicQuoteInput = z.input<typeof DeterministicQuoteInputSchema>;

export const RulePresentationSchema = z.object({
  label: z.string().min(1).max(300),
  category: z.enum(["design", "material", "construction", "surcharge", "adjustment"]),
  unit: z.string().min(1).max(50).optional(),
  quantity_key: z.string().min(1).max(100).optional(),
}).strict();
export type RulePresentation = z.infer<typeof RulePresentationSchema>;

export const QuoteEngineConfigSchema = z.object({
  rule_presentations: z.record(z.string().min(1).max(100), RulePresentationSchema),
  minimum_evidence_score: z.number().min(0).max(1).default(0.5),
  quote_validity_seconds: z.number().int().min(60).max(2_592_000).default(86_400),
  assumptions: z.array(z.string().min(1).max(500)).max(50).default([]),
  exclusions: z.array(z.string().min(1).max(500)).max(50).default([]),
  disclaimer: z.string().min(1).max(1_000),
}).strict();
export type QuoteEngineConfig = z.input<typeof QuoteEngineConfigSchema>;

export const InternalCostItemSchema = z.object({
  cost_item_id: IdSchema,
  cost_type: z.enum([
    "direct_rule",
    "procurement_wholesale",
    "delivery",
    "installation",
    "warranty",
    "gift",
    "free_service",
  ]),
  amount_fen: MoneyFenSchema,
  source_ref: z.string().min(1).max(500),
  rule_version_id: IdSchema.optional(),
  supplier_quote_snapshot_id: IdSchema.optional(),
}).strict();
export type InternalCostItem = z.infer<typeof InternalCostItemSchema>;

export const AppliedPromotionLedgerSchema = z.object({
  promotion_rule_version_id: IdSchema,
  promotion_id: z.string().min(1).max(100),
  approved_discount_fen: MoneyFenSchema,
  internal_benefit_cost_fen: MoneyFenSchema,
}).strict();
export type AppliedPromotionLedger = z.infer<typeof AppliedPromotionLedgerSchema>;

export const InternalQuoteCalculationSchema = z.object({
  calculation_id: IdSchema,
  quote_id: IdSchema,
  turn_id: IdSchema,
  request_hash: z.string().regex(/^[a-f0-9]{64}$/),
  quote_version: z.number().int().positive(),
  revenue_subtotal_fen: MoneyFenSchema,
  direct_cost_fen: MoneyFenSchema,
  procurement_cost_fen: MoneyFenSchema,
  gift_cost_fen: MoneyFenSchema,
  free_service_cost_fen: MoneyFenSchema,
  total_cost_fen: MoneyFenSchema,
  minimum_margin_bps: z.number().int().min(0).max(9_999),
  floor_revenue_fen: MoneyFenSchema,
  rule_discount_cap_fen: MoneyFenSchema,
  margin_headroom_fen: MoneyFenSchema,
  approved_discount_fen: MoneyFenSchema,
  final_revenue_fen: MoneyFenSchema,
  intent_level: IntentLevelSchema,
  supplier_snapshot_refs: z.array(IdSchema).max(500),
  rule_version_refs: z.array(RuleVersionRefSchema).min(1).max(500),
  knowledge_evidence_ids: z.array(IdSchema).min(1).max(100),
  cost_items: z.array(InternalCostItemSchema).max(2_000),
  applied_promotions: z.array(AppliedPromotionLedgerSchema).max(100),
  validation_codes: z.array(z.string().min(1).max(100)).max(100),
  valid_until: IsoDateTimeSchema,
  calculated_at: IsoDateTimeSchema,
}).strict();
export type InternalQuoteCalculation = z.infer<typeof InternalQuoteCalculationSchema>;

export interface QuoteEngineHooks {
  afterStep?(step: "quote_saved" | "internal_calculation_saved" | "cost_items_saved" | "promotions_saved"): void;
}

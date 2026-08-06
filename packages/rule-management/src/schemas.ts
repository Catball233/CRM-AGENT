import { z } from "zod";
import {
  IdSchema,
  IsoDateTimeSchema,
  MoneyFenSchema,
  RuleImportBundleSchema,
  RuleValidationIssueSchema,
} from "@crm-agent/contracts";

export const RuleSourceFormatSchema = z.enum(["json", "csv", "markdown"]);
export type RuleSourceFormat = z.infer<typeof RuleSourceFormatSchema>;

export const RuleSourceEvidenceSchema = z.object({
  source_ref: z.string().min(1).max(500),
  document_version: z.string().min(1).max(100),
  chunk_id: z.string().min(1).max(200),
  candidate_rule_ids: z.array(z.string().min(1).max(100)).min(1).max(500),
}).strict();
export type RuleSourceEvidence = z.infer<typeof RuleSourceEvidenceSchema>;

export const SupplierQuoteItemSchema = z.object({
  item_ref: z.string().min(1).max(200),
  category: z.enum(["furniture", "appliance", "soft_furnishing", "material", "service"]),
  quantity: z.number().finite().positive(),
  wholesale_cost_fen: MoneyFenSchema,
  delivery_cost_fen: MoneyFenSchema.default(0),
  installation_cost_fen: MoneyFenSchema.default(0),
  warranty_cost_fen: MoneyFenSchema.default(0),
}).strict();
export type SupplierQuoteItem = z.infer<typeof SupplierQuoteItemSchema>;

export const SupplierQuoteSnapshotSchema = z.object({
  supplier_quote_snapshot_id: IdSchema,
  supplier_ref: z.string().min(1).max(200),
  quote_version: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  currency: z.literal("CNY"),
  valid_from: IsoDateTimeSchema,
  valid_to: IsoDateTimeSchema,
  captured_at: IsoDateTimeSchema,
  items: z.array(SupplierQuoteItemSchema).min(1).max(500),
}).strict().superRefine((value, context) => {
  if (Date.parse(value.valid_to) <= Date.parse(value.valid_from)) {
    context.addIssue({ code: "custom", path: ["valid_to"], message: "valid_to must be after valid_from" });
  }
});
export type SupplierQuoteSnapshot = z.infer<typeof SupplierQuoteSnapshotSchema>;

export const RuleGuardrailSchema = z.object({
  rule_id: z.string().min(1).max(100),
  minimum_margin_bps: z.number().int().min(0).max(9_999),
  maximum_discount_bps: z.number().int().min(0).max(10_000),
  cost_rule_refs: z.array(z.string().min(1).max(100)).max(100).default([]),
  supplier_quote_snapshot_refs: z.array(IdSchema).max(100).default([]),
  gift_cost_fen: MoneyFenSchema.default(0),
  free_service_cost_fen: MoneyFenSchema.default(0),
}).strict();
export type RuleGuardrail = z.infer<typeof RuleGuardrailSchema>;

export const PromotionRuleSchema = z.object({
  promotion_rule_version_id: IdSchema,
  promotion_id: z.string().min(1).max(100),
  version: z.number().int().positive(),
  city: z.string().min(1).max(100),
  intent_levels: z.array(z.enum(["low", "medium", "high"])).min(1).max(3),
  benefit_type: z.enum(["cash_discount", "gift", "free_service"]),
  discount_bps: z.number().int().min(0).max(10_000).optional(),
  benefit_cost_fen: MoneyFenSchema.default(0),
  minimum_subtotal_fen: MoneyFenSchema.default(0),
  priority: z.number().int().default(0),
  exclusion_group: z.string().min(1).max(100).optional(),
  stackable: z.boolean().default(false),
  effective_from: IsoDateTimeSchema,
  effective_to: IsoDateTimeSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.benefit_type === "cash_discount" && value.discount_bps === undefined) {
    context.addIssue({ code: "custom", path: ["discount_bps"], message: "cash discount requires discount_bps" });
  }
  if (value.benefit_type !== "cash_discount" && value.discount_bps !== undefined) {
    context.addIssue({ code: "custom", path: ["discount_bps"], message: "non-cash benefit cannot set discount_bps" });
  }
  if (value.effective_to && Date.parse(value.effective_to) <= Date.parse(value.effective_from)) {
    context.addIssue({ code: "custom", path: ["effective_to"], message: "effective_to must be after effective_from" });
  }
});
export type PromotionRule = z.infer<typeof PromotionRuleSchema>;

export const ReconciliationCaseSchema = z.object({
  fixture_id: IdSchema,
  total_cost_fen: MoneyFenSchema,
  subtotal_fen: MoneyFenSchema,
  requested_discount_fen: MoneyFenSchema,
  minimum_margin_bps: z.number().int().min(0).max(9_999),
  expected_allowed: z.boolean(),
}).strict();
export type ReconciliationCase = z.infer<typeof ReconciliationCaseSchema>;

export const RuleImportMetadataSchema = RuleImportBundleSchema.omit({ rules: true });

export const RuleImportSourceSchema = z.object({
  format: RuleSourceFormatSchema,
  content: z.string().min(1),
  metadata: RuleImportMetadataSchema,
  source_evidence: z.array(RuleSourceEvidenceSchema).min(1).max(500),
  guardrails: z.array(RuleGuardrailSchema).min(1).max(500),
  supplier_quote_snapshots: z.array(SupplierQuoteSnapshotSchema).max(500).default([]),
  promotion_rules: z.array(PromotionRuleSchema).max(500).default([]),
  reconciliation_cases: z.array(ReconciliationCaseSchema).min(1).max(500),
}).strict();
export type RuleImportSource = z.input<typeof RuleImportSourceSchema>;

export const RuleValidationReportSchema = z.object({
  bundle_id: IdSchema,
  valid: z.boolean(),
  issues: z.array(RuleValidationIssueSchema).max(1_000),
}).strict();
export type RuleValidationReport = z.infer<typeof RuleValidationReportSchema>;

export const RuleActivationInputSchema = z.object({
  bundle_id: IdSchema,
  activated_at: IsoDateTimeSchema,
  approved_by: z.string().min(1).max(100),
  approval_note: z.string().min(1).max(1_000),
}).strict();
export type RuleActivationInput = z.infer<typeof RuleActivationInputSchema>;

export const RuleCatalogSchema = z.object({
  cities: z.array(z.string().min(1)).min(1),
  scenes: z.array(z.string().min(1)).min(1),
  trades: z.array(z.string().min(1)).min(1),
  material_tiers: z.array(z.string().min(1)).min(1),
  designer_tiers: z.array(z.string().min(1)).min(1),
}).strict();
export type RuleCatalog = z.infer<typeof RuleCatalogSchema>;

export interface RuleManagementHooks {
  afterStep?(boundary: "rule_import" | "rule_validation" | "rule_activation", step: string): void;
}

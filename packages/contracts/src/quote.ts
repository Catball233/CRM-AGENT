import { z } from "zod";
import {
  ContractVersionSchema,
  IdSchema,
  IsoDateTimeSchema,
  MoneyFenSchema,
  SlotNameSchema,
} from "./common";

export const HouseStateSchema = z.enum(["rough", "new_finished", "old_renovation"]);
export const ServiceScopeSchema = z.enum(["whole_home", "partial", "design_only"]);

export const QuoteParametersSchema = z
  .object({
    city: z.string().min(1).max(100),
    area_sqm: z.number().finite().positive().max(10_000),
    house_state: HouseStateSchema,
    service_scope: ServiceScopeSchema,
    material_tier: z.string().min(1).max(100),
    designer_tier: z.string().min(1).max(100).optional(),
    quantities: z.record(z.string().min(1), z.number().finite().nonnegative()),
    special_requirements: z.array(z.string().min(1).max(500)).max(50),
  })
  .strict();
export type QuoteParameters = z.infer<typeof QuoteParametersSchema>;

export const QuoteRequestSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation_id: IdSchema,
    turn_id: IdSchema,
    parent_quote_id: IdSchema.optional(),
    confirmed_parameters: QuoteParametersSchema,
    candidate_rule_ids: z.array(z.string().min(1).max(100)).max(100),
    knowledge_evidence_ids: z.array(IdSchema).max(100),
    requested_at: IsoDateTimeSchema,
  })
  .strict();
export type QuoteRequest = z.infer<typeof QuoteRequestSchema>;

export const CalculationTypeSchema = z.enum([
  "FIXED_AMOUNT",
  "AREA_MULTIPLY",
  "QUANTITY_MULTIPLY",
  "TIER_COEFFICIENT",
  "CONDITIONAL_SURCHARGE",
  "MINIMUM_PRICE",
]);

export const RuleVersionRefSchema = z
  .object({
    rule_id: z.string().min(1).max(100),
    rule_version_id: IdSchema,
    version: z.number().int().positive(),
  })
  .strict();

export const QuoteItemSchema = z
  .object({
    quote_item_id: IdSchema,
    category: z.enum(["design", "material", "construction", "surcharge", "adjustment"]),
    label: z.string().min(1).max(300),
    calculation_type: CalculationTypeSchema,
    quantity: z.number().finite().nonnegative().optional(),
    unit: z.string().min(1).max(50).optional(),
    unit_price_fen: MoneyFenSchema.optional(),
    amount_fen: MoneyFenSchema,
    calculation_inputs: z.record(
      z.string().min(1),
      z.union([z.string(), z.number().finite(), z.boolean()]),
    ),
    rule_ref: RuleVersionRefSchema,
  })
  .strict();
export type QuoteItem = z.infer<typeof QuoteItemSchema>;

export const QuoteResultSchema = z
  .object({
    contract_version: ContractVersionSchema,
    quote_id: IdSchema,
    conversation_id: IdSchema,
    quote_version: z.number().int().positive(),
    parent_quote_id: IdSchema.nullable(),
    status: z.literal("estimated"),
    currency: z.literal("CNY"),
    parameters_snapshot: QuoteParametersSchema,
    items: z.array(QuoteItemSchema).min(1).max(200),
    estimated_total_fen: MoneyFenSchema,
    rule_versions: z.array(RuleVersionRefSchema).min(1).max(200),
    knowledge_evidence_ids: z.array(IdSchema).max(100),
    assumptions: z.array(z.string().min(1).max(500)).max(50),
    exclusions: z.array(z.string().min(1).max(500)).max(50),
    disclaimer: z.string().min(1).max(1_000),
    created_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    const itemTotal = value.items.reduce((total, item) => total + item.amount_fen, 0);
    if (itemTotal !== value.estimated_total_fen) {
      context.addIssue({
        code: "custom",
        path: ["estimated_total_fen"],
        message: "estimated_total_fen must equal the sum of quote items",
      });
    }
  });
export type QuoteResult = z.infer<typeof QuoteResultSchema>;

export const QuoteUnavailableSchema = z
  .object({
    contract_version: ContractVersionSchema,
    reason: z.enum([
      "missing_fields",
      "knowledge_insufficient",
      "no_active_rule",
      "rule_not_applicable",
      "rule_conflict",
    ]),
    missing_fields: z.array(SlotNameSchema).max(20),
    conflicting_rule_ids: z.array(z.string().min(1).max(100)).max(100),
    user_safe_message: z.string().min(1).max(1_000),
  })
  .strict();

export const QuoteOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("quote"), quote: QuoteResultSchema }).strict(),
  z.object({ kind: z.literal("unavailable"), unavailable: QuoteUnavailableSchema }).strict(),
]);
export type QuoteOutcome = z.infer<typeof QuoteOutcomeSchema>;

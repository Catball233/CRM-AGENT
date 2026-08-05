import { z } from "zod";
import { ContractVersionSchema, IdSchema, IsoDateTimeSchema, MoneyFenSchema } from "./common";
import { CalculationTypeSchema } from "./quote";

export const RuleDefinitionSchema = z
  .object({
    rule_id: z.string().min(1).max(100),
    version: z.number().int().positive(),
    city: z.string().min(1).max(100),
    calculation_type: CalculationTypeSchema,
    amount_fen: MoneyFenSchema.optional(),
    unit_price_fen: MoneyFenSchema.optional(),
    coefficient: z.number().finite().positive().optional(),
    base_rule_id: z.string().min(1).max(100).optional(),
    minimum_price_fen: MoneyFenSchema.optional(),
    conditions: z.record(
      z.string().min(1),
      z.union([z.string(), z.number().finite(), z.boolean()]),
    ),
    conflict_group: z.string().min(1).max(100).optional(),
    effective_from: IsoDateTimeSchema,
    effective_to: IsoDateTimeSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const requiredByType: Partial<Record<typeof value.calculation_type, keyof typeof value>> = {
      FIXED_AMOUNT: "amount_fen",
      AREA_MULTIPLY: "unit_price_fen",
      QUANTITY_MULTIPLY: "unit_price_fen",
      TIER_COEFFICIENT: "coefficient",
      CONDITIONAL_SURCHARGE: "amount_fen",
      MINIMUM_PRICE: "minimum_price_fen",
    };
    const requiredField = requiredByType[value.calculation_type];
    if (requiredField && value[requiredField] === undefined) {
      context.addIssue({
        code: "custom",
        path: [requiredField],
        message: `${requiredField} is required for ${value.calculation_type}`,
      });
    }
    if (value.calculation_type === "TIER_COEFFICIENT" && !value.base_rule_id) {
      context.addIssue({
        code: "custom",
        path: ["base_rule_id"],
        message: "base_rule_id is required for TIER_COEFFICIENT",
      });
    }
    if (value.base_rule_id === value.rule_id) {
      context.addIssue({ code: "custom", path: ["base_rule_id"], message: "rule cannot reference itself" });
    }
  });

export const RuleImportBundleSchema = z
  .object({
    contract_version: ContractVersionSchema,
    bundle_id: IdSchema,
    source_document: z.string().min(1).max(500),
    source_version: z.string().min(1).max(100),
    rules: z.array(RuleDefinitionSchema).min(1).max(500),
    fixture_owner: z.string().min(1).max(100),
    fixture_reviewer: z.string().min(1).max(100),
    reconciliation_fixture_ids: z.array(IdSchema).min(1).max(500),
  })
  .strict();

export const RuleValidationIssueSchema = z
  .object({
    rule_id: z.string().min(1).max(100).optional(),
    code: z.string().min(1).max(100),
    message: z.string().min(1).max(1_000),
    severity: z.enum(["error", "warning"]),
  })
  .strict();

export const RuleValidationResultSchema = z
  .object({
    valid: z.boolean(),
    issues: z.array(RuleValidationIssueSchema).max(1_000),
  })
  .strict();

export const RuleImportResultSchema = z
  .object({
    bundle_id: IdSchema,
    candidate_rule_version_ids: z.array(IdSchema).min(1).max(500),
  })
  .strict();

export const RuleActivationResultSchema = z
  .object({
    activated_rule_version_ids: z.array(IdSchema).max(500),
    rejected_rule_version_ids: z.array(IdSchema).max(500),
    issues: z.array(RuleValidationIssueSchema).max(1_000),
  })
  .strict();

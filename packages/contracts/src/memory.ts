import { z } from "zod";
import {
  ContractVersionSchema,
  ConversationStageSchema,
  IdSchema,
  IsoDateTimeSchema,
  MoneyFenSchema,
  SlotStatusSchema,
  SlotValueSchema,
  SourceRefSchema,
} from "./common";
import { MessageViewSchema } from "./conversation";

export const FactKeySchema = z.enum([
  "city",
  "area_sqm",
  "layout",
  "house_state",
  "service_scope",
  "designer_tier",
  "material_tier",
  "budget_max_fen",
  "expected_start_date",
  "quantities",
  "special_requirements",
  "preference",
  "concern",
  "decision_timeline",
]);

export const FactCategorySchema = z.enum([
  "requirement",
  "preference",
  "concern",
  "sales_signal",
]);

export const CustomerFactSchema = z
  .object({
    fact_id: IdSchema,
    fact_key: FactKeySchema,
    category: FactCategorySchema,
    value: SlotValueSchema,
    status: SlotStatusSchema,
    confidence: z.number().min(0).max(1).optional(),
    source_refs: z.array(SourceRefSchema).min(1).max(20),
    updated_at: IsoDateTimeSchema,
  })
  .strict();
export type CustomerFact = z.infer<typeof CustomerFactSchema>;

export const MemorySummaryViewSchema = z
  .object({
    summary_id: IdSchema,
    version: z.number().int().positive(),
    text: z.string().min(1).max(8_000),
    covers_sequence_from: z.number().int().positive(),
    covers_sequence_to: z.number().int().positive(),
    source_message_ids: z.array(IdSchema).min(1).max(200),
    created_at: IsoDateTimeSchema,
  })
  .strict()
  .refine((value) => value.covers_sequence_to >= value.covers_sequence_from, {
    message: "summary sequence range is invalid",
    path: ["covers_sequence_to"],
  });

export const QuoteSummaryViewSchema = z
  .object({
    quote_id: IdSchema,
    quote_version: z.number().int().positive(),
    estimated_total_fen: MoneyFenSchema,
    material_tier: z.string().min(1).optional(),
    designer_tier: z.string().min(1).optional(),
    created_at: IsoDateTimeSchema,
  })
  .strict();

export const RecalledItemSchema = z
  .object({
    source_ref: SourceRefSchema,
    reason: z.string().min(1).max(500),
    relevance_score: z.number().min(0).max(1).optional(),
  })
  .strict();

export const ContextBundleSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation_id: IdSchema,
    stage: ConversationStageSchema,
    recent_messages: z.array(MessageViewSchema).max(20),
    confirmed_facts: z.array(CustomerFactSchema).max(100),
    inferred_facts: z.array(CustomerFactSchema).max(100),
    conflicted_facts: z.array(CustomerFactSchema).max(100),
    memory_summary: MemorySummaryViewSchema.nullable(),
    current_quote: QuoteSummaryViewSchema.nullable(),
    recalled_items: z.array(RecalledItemSchema).max(50),
    built_at: IsoDateTimeSchema,
  })
  .strict();
export type ContextBundle = z.infer<typeof ContextBundleSchema>;

export const MemoryMutationPlanSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation_id: IdSchema,
    turn_id: IdSchema,
    fact_upserts: z.array(CustomerFactSchema).max(100),
    fact_ids_to_mark_conflicted: z.array(IdSchema).max(100),
    summary_upsert: MemorySummaryViewSchema.nullable(),
  })
  .strict();
export type MemoryMutationPlan = z.infer<typeof MemoryMutationPlanSchema>;
export type FactKey = z.infer<typeof FactKeySchema>;
export type FactCategory = z.infer<typeof FactCategorySchema>;
export type MemorySummaryView = z.infer<typeof MemorySummaryViewSchema>;
export type QuoteSummaryView = z.infer<typeof QuoteSummaryViewSchema>;
export type RecalledItem = z.infer<typeof RecalledItemSchema>;

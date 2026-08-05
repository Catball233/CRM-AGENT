import { z } from "zod";

export const CONTRACT_VERSION = "1.0.0" as const;
export const ContractVersionSchema = z.literal(CONTRACT_VERSION);
export const IdSchema = z.string().uuid();
export const IsoDateTimeSchema = z.string().datetime({ offset: true });
export const MoneyFenSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const ConversationStageSchema = z.enum([
  "DISCOVERY",
  "QUALIFYING",
  "QUOTING",
  "NEGOTIATION",
  "COMPLETED",
  "CLOSED",
]);
export type ConversationStage = z.infer<typeof ConversationStageSchema>;

export const ConversationStatusSchema = z.enum(["ACTIVE", "CLOSED"]);
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;

export const TurnStatusSchema = z.enum(["PROCESSING", "COMPLETED", "FAILED"]);
export type TurnStatus = z.infer<typeof TurnStatusSchema>;

export const IntentSchema = z.enum([
  "greeting",
  "consulting",
  "quote_request",
  "provide_information",
  "negotiation",
  "plan_adjustment",
  "rejection",
  "unrelated",
  "risk",
  "unclear",
]);
export type Intent = z.infer<typeof IntentSchema>;

export const IntentLevelSchema = z.enum(["high", "medium", "low", "unknown"]);
export type IntentLevel = z.infer<typeof IntentLevelSchema>;

export const NextActionSchema = z.enum([
  "answer_question",
  "ask_missing_fields",
  "search_knowledge",
  "prepare_quote",
  "adjust_quote",
  "clarify_conflict",
  "stop_sales_guidance",
  "safe_stop",
]);
export type NextAction = z.infer<typeof NextActionSchema>;

export const TurnOutcomeSchema = z.enum(["answer", "question", "quote", "safe_stop"]);
export type TurnOutcome = z.infer<typeof TurnOutcomeSchema>;

export const SourceTypeSchema = z.enum([
  "message",
  "memory_summary",
  "knowledge_chunk",
  "quote",
]);

export const SourceRefSchema = z
  .object({
    source_type: SourceTypeSchema,
    source_id: IdSchema,
    excerpt: z.string().min(1).max(500).optional(),
    start_offset: z.number().int().nonnegative().optional(),
    end_offset: z.number().int().nonnegative().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.start_offset === undefined) !== (value.end_offset === undefined)) {
      context.addIssue({
        code: "custom",
        message: "start_offset and end_offset must be provided together",
      });
    }
    if (
      value.start_offset !== undefined &&
      value.end_offset !== undefined &&
      value.end_offset < value.start_offset
    ) {
      context.addIssue({ code: "custom", message: "end_offset must not precede start_offset" });
    }
  });
export type SourceRef = z.infer<typeof SourceRefSchema>;

export const SlotNameSchema = z.enum([
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
]);
export type SlotName = z.infer<typeof SlotNameSchema>;

export const SlotStatusSchema = z.enum(["confirmed", "inferred", "conflicted"]);
export type SlotStatus = z.infer<typeof SlotStatusSchema>;

export const SlotValueSchema = z.union([
  z.string().min(1),
  z.number().finite(),
  z.array(z.string().min(1)).max(50),
  z.record(z.string().min(1), z.number().finite().nonnegative()),
]);
export type SlotValue = z.infer<typeof SlotValueSchema>;

export const SlotUpdateSchema = z
  .object({
    slot: SlotNameSchema,
    value: SlotValueSchema,
    status: SlotStatusSchema,
    confidence: z.number().min(0).max(1).optional(),
    source_refs: z.array(SourceRefSchema).min(1).max(20),
    conflicts_with_fact_ids: z.array(IdSchema).max(20).optional(),
  })
  .strict();
export type SlotUpdate = z.infer<typeof SlotUpdateSchema>;

export const MissingFieldSchema = z
  .object({
    slot: SlotNameSchema,
    reason: z.string().min(1).max(300),
    priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  })
  .strict();
export type MissingField = z.infer<typeof MissingFieldSchema>;

export const ConcernCodeSchema = z.enum([
  "price",
  "material",
  "design",
  "timeline",
  "quality",
  "after_sales",
  "unclear",
  "other",
]);

export const ConcernSchema = z
  .object({
    code: ConcernCodeSchema,
    note: z.string().min(1).max(500).optional(),
    evidence_refs: z.array(SourceRefSchema).min(1).max(20),
  })
  .strict();
export type Concern = z.infer<typeof ConcernSchema>;

export const ValueAssessmentSchema = z
  .object({
    level: IntentLevelSchema,
    evidence_refs: z.array(SourceRefSchema).max(20),
    reason_codes: z.array(z.string().min(1).max(100)).max(20),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.level !== "unknown" &&
      !value.evidence_refs.some((reference) => reference.source_type === "message")
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidence_refs"],
        message: "known value levels require customer message evidence",
      });
    }
  });
export type ValueAssessment = z.infer<typeof ValueAssessmentSchema>;

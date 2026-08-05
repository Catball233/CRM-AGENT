import { z } from "zod";
import {
  ConcernSchema,
  ContractVersionSchema,
  IdSchema,
  IntentSchema,
  NextActionSchema,
  SlotNameSchema,
  SlotUpdateSchema,
  MissingFieldSchema,
  SourceRefSchema,
  ValueAssessmentSchema,
  ConversationStageSchema,
} from "./common";
import { UserMessageViewSchema } from "./conversation";
import { ContextBundleSchema } from "./memory";
import { KnowledgeEvidenceSchema } from "./knowledge";
import { QuoteOutcomeSchema } from "./quote";

export const KnowledgeDecisionSchema = z
  .object({
    should_search: z.boolean(),
    reason_codes: z.array(z.string().min(1).max(100)).max(20),
    topics: z.array(z.string().min(1).max(100)).max(10),
    query_hint: z.string().min(1).max(1_000).optional(),
  })
  .strict();

export const SafetyFlagSchema = z
  .object({
    code: z.enum(["prompt_injection", "secret_request", "external_action", "pii", "other"]),
    severity: z.enum(["low", "medium", "high"]),
    evidence_refs: z.array(SourceRefSchema).min(1).max(20),
  })
  .strict();

export const ModelMetadataSchema = z
  .object({
    provider: z.literal("aliyun_bailian"),
    model_id: z.string().min(1).max(200),
    prompt_version: z.string().min(1).max(100),
  })
  .strict();

export const AnalysisResultSchema = z
  .object({
    contract_version: ContractVersionSchema,
    intent: IntentSchema,
    stage_recommendation: ConversationStageSchema,
    value_assessment: ValueAssessmentSchema,
    concerns: z.array(ConcernSchema).max(20),
    slot_updates: z.array(SlotUpdateSchema).max(50),
    missing_fields: z.array(MissingFieldSchema).max(20),
    recommended_next_action: NextActionSchema,
    knowledge_decision: KnowledgeDecisionSchema,
    safety_flags: z.array(SafetyFlagSchema).max(20),
    model_metadata: ModelMetadataSchema,
  })
  .strict();
export type AnalysisResult = z.infer<typeof AnalysisResultSchema>;

export const AnalysisRequestSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation_id: IdSchema,
    turn_id: IdSchema,
    current_message: UserMessageViewSchema,
    context: ContextBundleSchema,
  })
  .strict()
  .refine((value) => value.context.conversation_id === value.conversation_id, {
    message: "context conversation must match request conversation",
    path: ["context", "conversation_id"],
  });

export const ReplyGenerationRequestSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation_id: IdSchema,
    turn_id: IdSchema,
    analysis: AnalysisResultSchema,
    context: ContextBundleSchema,
    knowledge_evidence: z.array(KnowledgeEvidenceSchema).max(20),
    quote_outcome: QuoteOutcomeSchema.optional(),
  })
  .strict();

export const ReplyDraftSchema = z
  .object({
    contract_version: ContractVersionSchema,
    text: z.string().min(1).max(8_000),
    cited_evidence_ids: z.array(IdSchema).max(20),
    question_fields: z.array(SlotNameSchema).max(3),
  })
  .strict();

import { z } from "zod";
import { AnalysisResultSchema } from "./ai";
import {
  ContractVersionSchema,
  ConversationStageSchema,
  IdSchema,
  IntentLevelSchema,
  IsoDateTimeSchema,
  SlotNameSchema,
  TurnOutcomeSchema,
} from "./common";
import {
  AssistantMessageViewSchema,
  ConversationViewSchema,
  MessageViewSchema,
  UserMessageViewSchema,
} from "./conversation";
import { ApiErrorBodySchema } from "./error";
import { KnowledgeEvidenceSchema } from "./knowledge";
import { ContextBundleSchema } from "./memory";
import { QuoteOutcomeSchema, QuoteResultSchema } from "./quote";

export const CreateConversationRequestSchema = z
  .object({ contract_version: ContractVersionSchema })
  .strict();

export const ResponseModeSchema = z.enum(["complete", "stream"]);

export const SendMessageRequestSchema = z
  .object({
    contract_version: ContractVersionSchema,
    client_message_id: IdSchema,
    content: z.string().min(1).max(8_000),
    response_mode: ResponseModeSchema,
  })
  .strict();

export const RetryTurnRequestSchema = z
  .object({
    contract_version: ContractVersionSchema,
    retry_request_id: IdSchema,
    response_mode: ResponseModeSchema,
  })
  .strict();

export const ChatTurnResultSchema = z
  .object({
    contract_version: ContractVersionSchema,
    turn_id: IdSchema,
    conversation_id: IdSchema,
    client_message_id: IdSchema,
    status: z.literal("COMPLETED"),
    outcome: TurnOutcomeSchema,
    stage: ConversationStageSchema,
    user_message: UserMessageViewSchema,
    assistant_message: AssistantMessageViewSchema,
    question_fields: z.array(SlotNameSchema).max(3),
    quote: QuoteResultSchema.nullable(),
    warnings: z.array(z.string().min(1).max(500)).max(50),
    replayed: z.boolean(),
    completed_at: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.outcome === "quote") !== (value.quote !== null)) {
      context.addIssue({
        code: "custom",
        path: ["quote"],
        message: "quote must be present if and only if outcome is quote",
      });
    }
    if (value.outcome === "question" && value.question_fields.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["question_fields"],
        message: "question outcome requires at least one question field",
      });
    }
  });
export type ChatTurnResult = z.infer<typeof ChatTurnResultSchema>;

export const ConversationSnapshotSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation: ConversationViewSchema,
    messages: z.array(MessageViewSchema).max(1_000),
    current_quote: QuoteResultSchema.nullable(),
    active_turn_id: IdSchema.nullable(),
  })
  .strict();

export const TurnAcceptedViewSchema = z
  .object({
    contract_version: ContractVersionSchema,
    turn_id: IdSchema,
    conversation_id: IdSchema,
    client_message_id: IdSchema,
    status: z.literal("PROCESSING"),
    code: z.literal("MESSAGE_IN_PROGRESS"),
  })
  .strict();

const EventBaseShape = {
  contract_version: ContractVersionSchema,
  event_id: IdSchema,
  sequence: z.number().int().positive(),
  conversation_id: IdSchema,
  turn_id: IdSchema,
  emitted_at: IsoDateTimeSchema,
};

export const ChatEventSchema = z.discriminatedUnion("event_type", [
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("turn.accepted"),
      payload: z
        .object({ client_message_id: IdSchema, replayed: z.boolean() })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("analysis.completed"),
      payload: z
        .object({
          intent: AnalysisResultSchema.shape.intent,
          value_level: IntentLevelSchema,
          next_action: AnalysisResultSchema.shape.recommended_next_action,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("message.delta"),
      payload: z
        .object({
          message_id: IdSchema,
          delta: z.string().min(1).max(8_000),
          index: z.number().int().nonnegative(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("question.required"),
      payload: z
        .object({
          message: AssistantMessageViewSchema,
          question_fields: z.array(SlotNameSchema).min(1).max(3),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("quote.ready"),
      payload: z
        .object({ message: AssistantMessageViewSchema, quote: QuoteResultSchema })
        .strict(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("message.completed"),
      payload: z.object({ message: AssistantMessageViewSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("turn.completed"),
      payload: z.object({ result: ChatTurnResultSchema }).strict(),
    })
    .strict(),
  z
    .object({
      ...EventBaseShape,
      event_type: z.literal("turn.failed"),
      payload: z.object({ error: ApiErrorBodySchema }).strict(),
    })
    .strict(),
]);
export type ChatEvent = z.infer<typeof ChatEventSchema>;

export const DebugTurnSnapshotSchema = z
  .object({
    contract_version: ContractVersionSchema,
    turn_id: IdSchema,
    analysis: AnalysisResultSchema.nullable(),
    context: ContextBundleSchema,
    knowledge_evidence: z.array(KnowledgeEvidenceSchema).max(20),
    quote_outcome: QuoteOutcomeSchema.nullable(),
    audit_codes: z.array(z.string().min(1).max(100)).max(100),
  })
  .strict();

export const HealthResponseSchema = z
  .object({
    status: z.literal("ok"),
    database: z.enum(["ok", "not_initialized"]),
    contract_version: ContractVersionSchema,
  })
  .strict();

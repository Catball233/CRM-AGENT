import { z } from "zod";
import {
  CustomerFactSchema,
  IdSchema,
  IsoDateTimeSchema,
  MemorySummaryViewSchema,
  MessageViewSchema,
  QuoteResultSchema,
  RuleDefinitionSchema,
  RuleVersionRefSchema,
  TurnOutcomeSchema,
  TurnStatusSchema,
} from "@crm-agent/contracts";

export const PersistedTurnSchema = z
  .object({
    turn_id: IdSchema,
    conversation_id: IdSchema,
    client_message_id: IdSchema,
    retry_request_id: IdSchema.nullable(),
    status: TurnStatusSchema,
    outcome: TurnOutcomeSchema.nullable(),
    started_at: IsoDateTimeSchema,
    completed_at: IsoDateTimeSchema.nullable(),
    failure_code: z.string().min(1).max(200).nullable(),
    warnings: z.array(z.string().min(1).max(1_000)).max(100),
    messages: z.array(MessageViewSchema).min(1),
  })
  .strict();
export type PersistedTurn = z.infer<typeof PersistedTurnSchema>;

export const SaveTurnInputSchema = z
  .object({
    conversation_id: IdSchema,
    turn_id: IdSchema,
    client_message_id: IdSchema,
    retry_request_id: IdSchema.optional(),
    status: TurnStatusSchema,
    outcome: TurnOutcomeSchema.optional(),
    started_at: IsoDateTimeSchema,
    completed_at: IsoDateTimeSchema.optional(),
    failure_code: z.string().min(1).max(200).optional(),
    warnings: z.array(z.string().min(1).max(1_000)).max(100).default([]),
    messages: z.array(MessageViewSchema).min(1).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const clientMessage = value.messages.find((message) => message.message_id === value.client_message_id);
    if (!clientMessage || clientMessage.role !== "user") {
      context.addIssue({
        code: "custom",
        path: ["client_message_id"],
        message: "client_message_id must identify a user message in this turn",
      });
    }
    if (value.status === "PROCESSING" && value.completed_at !== undefined) {
      context.addIssue({ code: "custom", path: ["completed_at"], message: "processing turn cannot be completed" });
    }
    if (value.status !== "PROCESSING" && value.completed_at === undefined) {
      context.addIssue({ code: "custom", path: ["completed_at"], message: "completed_at is required" });
    }
    if (value.status === "COMPLETED" && value.outcome === undefined) {
      context.addIssue({ code: "custom", path: ["outcome"], message: "completed turn requires an outcome" });
    }
  });
export type SaveTurnInput = z.input<typeof SaveTurnInputSchema>;

export const ConversationFactInputSchema = z
  .object({
    conversation_id: IdSchema,
    fact: CustomerFactSchema,
  })
  .strict();
export type ConversationFactInput = z.infer<typeof ConversationFactInputSchema>;

export const MemoryStateSchema = z
  .object({
    conversation_id: IdSchema,
    confirmed_facts: z.array(CustomerFactSchema).max(100),
    inferred_facts: z.array(CustomerFactSchema).max(100),
    conflicted_facts: z.array(CustomerFactSchema).max(100),
    latest_summary: MemorySummaryViewSchema.nullable(),
  })
  .strict();
export type MemoryState = z.infer<typeof MemoryStateSchema>;

export const RuleVersionStatusSchema = z.enum(["draft", "validated", "active", "inactive", "expired"]);
export type RuleVersionStatus = z.infer<typeof RuleVersionStatusSchema>;

export const RuleVersionRecordSchema = z
  .object({
    rule_version_id: IdSchema,
    status: RuleVersionStatusSchema,
    definition: RuleDefinitionSchema,
    source_document: z.string().min(1).max(500),
    source_version: z.string().min(1).max(100),
    fixture_owner: z.string().min(1).max(100),
    fixture_reviewer: z.string().min(1).max(100),
    created_at: IsoDateTimeSchema,
    validated_at: IsoDateTimeSchema.nullable(),
    activated_at: IsoDateTimeSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (["validated", "active"].includes(value.status) && value.validated_at === null) {
      context.addIssue({ code: "custom", path: ["validated_at"], message: "validated_at is required" });
    }
    if (value.status === "active" && value.activated_at === null) {
      context.addIssue({ code: "custom", path: ["activated_at"], message: "activated_at is required" });
    }
  });
export type RuleVersionRecord = z.infer<typeof RuleVersionRecordSchema>;

export const ActivateRuleInputSchema = z
  .object({
    rule_version_id: IdSchema,
    activated_at: IsoDateTimeSchema,
  })
  .strict();
export type ActivateRuleInput = z.infer<typeof ActivateRuleInputSchema>;

export const ResolvedRuleSetSchema = z
  .object({
    requested_rule_ids: z.array(z.string().min(1).max(100)).max(100),
    active_rule_versions: z.array(RuleVersionRefSchema).max(100),
    unavailable_rule_ids: z.array(z.string().min(1).max(100)).max(100),
    conflict_groups: z.array(z.array(z.string().min(1).max(100)).min(2).max(100)).max(100),
  })
  .strict();
export type ResolvedRuleSet = z.infer<typeof ResolvedRuleSetSchema>;

export const SaveQuoteInputSchema = z
  .object({
    turn_id: IdSchema,
    quote: QuoteResultSchema,
  })
  .strict();
export type SaveQuoteInput = z.infer<typeof SaveQuoteInputSchema>;

export type TransactionBoundary = "message_save" | "rule_activation" | "quote_save";

export interface TransactionHooks {
  afterStep?(boundary: TransactionBoundary, step: string): void;
}

import { z } from "zod";
import {
  ContractVersionSchema,
  ConversationStageSchema,
  ConversationStatusSchema,
  IdSchema,
  IsoDateTimeSchema,
} from "./common";

const BaseMessageShape = {
  message_id: IdSchema,
  content: z.string().min(1).max(8_000),
  sequence: z.number().int().positive(),
  created_at: IsoDateTimeSchema,
};

export const UserMessageViewSchema = z
  .object({
    ...BaseMessageShape,
    role: z.literal("user"),
  })
  .strict();
export type UserMessageView = z.infer<typeof UserMessageViewSchema>;

export const AssistantMessageViewSchema = z
  .object({
    ...BaseMessageShape,
    role: z.literal("assistant"),
    cited_evidence_ids: z.array(IdSchema).max(20),
  })
  .strict();
export type AssistantMessageView = z.infer<typeof AssistantMessageViewSchema>;

export const MessageViewSchema = z.discriminatedUnion("role", [
  UserMessageViewSchema,
  AssistantMessageViewSchema,
]);
export type MessageView = z.infer<typeof MessageViewSchema>;

export const ConversationViewSchema = z
  .object({
    contract_version: ContractVersionSchema,
    conversation_id: IdSchema,
    stage: ConversationStageSchema,
    status: ConversationStatusSchema,
    created_at: IsoDateTimeSchema,
    updated_at: IsoDateTimeSchema,
  })
  .strict();
export type ConversationView = z.infer<typeof ConversationViewSchema>;

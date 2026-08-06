import type { ChatEvent, ConversationView } from "@crm-agent/contracts";
import {
  ConversationSnapshotSchema,
  SendMessageRequestSchema,
} from "@crm-agent/contracts";
import type { z } from "zod";

export type ConversationSnapshot = z.output<typeof ConversationSnapshotSchema>;
export type SendMessageRequest = z.output<typeof SendMessageRequestSchema>;

export interface ChatGateway {
  createConversation(): Promise<ConversationView>;
  getConversation(conversationId: string): Promise<ConversationSnapshot>;
  deleteConversation(conversationId: string): Promise<void>;
  sendMessage(
    conversationId: string,
    request: SendMessageRequest,
  ): AsyncIterable<ChatEvent>;
}

export type ChatGatewayErrorCode = "network" | "not_found" | "contract" | "unknown";

export class ChatGatewayError extends Error {
  readonly code: ChatGatewayErrorCode;

  constructor(code: ChatGatewayErrorCode, message: string) {
    super(message);
    this.name = "ChatGatewayError";
    this.code = code;
  }
}

export function getSafeErrorMessage(error: unknown) {
  if (error instanceof ChatGatewayError) return error.message;
  return "本地聊天服务暂时不可用，请稍后重试。";
}

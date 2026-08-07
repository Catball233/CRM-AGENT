import {
  ChatEventSchema,
  ConversationSnapshotSchema,
  ConversationViewSchema,
  type AssistantMessageView,
  type ChatEvent,
  type ChatTurnResult,
  type ConversationView,
  type UserMessageView,
} from "@crm-agent/contracts";
import type { ChatGateway, ConversationSnapshot, SendMessageRequest } from "../../chat/chat-gateway";

export interface ScriptContext {
  conversationId: string;
  clientMessageId: string;
  userContent: string;
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
  userSequence: number;
  assistantSequence: number;
  emittedAt: string;
}

export type ScenarioScript = (ctx: ScriptContext) => ChatEvent[];

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * ScriptedChatGateway is a deterministic test double for the ChatGateway used by
 * end-to-end scenarios that the MockChatGateway cannot naturally produce (for
 * example the S08 "no_active_rule" unavailable outcome). It replays pre-built
 * ChatEvent streams, remapping ids to the real conversation/client message ids so
 * the chat-event reducer accepts them, and maintains a conversation snapshot so
 * getConversation() keeps the workspace UI consistent after each turn.
 *
 * It does NOT modify apps/web/src/chat/mock-chat-gateway.ts (D-03); the mock
 * gateway's own no_active_rule trigger is deferred to the D-03 P1 follow-up.
 */
export class ScriptedChatGateway implements ChatGateway {
  private readonly scripts: ScenarioScript[];
  private readonly snapshots = new Map<string, ConversationSnapshot>();

  constructor(scripts: readonly ScenarioScript[]) {
    this.scripts = [...scripts];
  }

  async createConversation(): Promise<ConversationView> {
    const conversationId = uuid();
    const now = new Date().toISOString();
    const snapshot = ConversationSnapshotSchema.parse({
      contract_version: "1.0.0",
      conversation: {
        contract_version: "1.0.0",
        conversation_id: conversationId,
        stage: "DISCOVERY",
        status: "ACTIVE",
        created_at: now,
        updated_at: now,
      },
      messages: [],
      current_quote: null,
      active_turn_id: null,
    }) as ConversationSnapshot;
    this.snapshots.set(conversationId, snapshot);
    return ConversationViewSchema.parse(snapshot.conversation) as ConversationView;
  }

  async getConversation(conversationId: string): Promise<ConversationSnapshot> {
    const snapshot = this.snapshots.get(conversationId);
    if (!snapshot) throw new Error(`conversation not found: ${conversationId}`);
    return ConversationSnapshotSchema.parse(snapshot) as ConversationSnapshot;
  }

  async deleteConversation(conversationId: string): Promise<void> {
    this.snapshots.delete(conversationId);
  }

  async *sendMessage(
    conversationId: string,
    request: SendMessageRequest,
  ): AsyncIterable<ChatEvent> {
    const script = this.scripts.shift();
    if (!script) throw new Error("ScriptedChatGateway: no script queued for sendMessage");
    const snapshot = this.snapshots.get(conversationId);
    if (!snapshot) throw new Error(`conversation not found: ${conversationId}`);

    const ctx: ScriptContext = {
      conversationId,
      clientMessageId: request.client_message_id,
      userContent: request.content,
      turnId: uuid(),
      userMessageId: uuid(),
      assistantMessageId: uuid(),
      userSequence: snapshot.messages.length + 1,
      assistantSequence: snapshot.messages.length + 2,
      emittedAt: new Date().toISOString(),
    };
    const events = script(ctx);
    for (const event of events) {
      yield ChatEventSchema.parse(event) as ChatEvent;
    }
    const terminal = events[events.length - 1];
    if (terminal && terminal.event_type === "turn.completed") {
      const result = terminal.payload.result;
      const next = ConversationSnapshotSchema.parse({
        contract_version: "1.0.0",
        conversation: {
          contract_version: "1.0.0",
          conversation_id: conversationId,
          stage: result.stage,
          status: snapshot.conversation.status,
          created_at: snapshot.conversation.created_at,
          updated_at: ctx.emittedAt,
        },
        messages: [...snapshot.messages, result.user_message, result.assistant_message],
        current_quote: result.quote,
        active_turn_id: null,
      }) as ConversationSnapshot;
      this.snapshots.set(conversationId, next);
    }
  }
}

/**
 * S08 script: the orchestrator finds no active rule for the requested quote, so
 * it returns a safe_stop turn with warnings:["no_active_rule"] and no quote. The
 * workspace must render the unavailable status card and never show an amount.
 */
export function noActiveRuleScript(): ScenarioScript {
  return (ctx: ScriptContext): ChatEvent[] => {
    const now = ctx.emittedAt;
    const userMessage: UserMessageView = {
      message_id: ctx.userMessageId,
      role: "user",
      content: ctx.userContent,
      sequence: ctx.userSequence,
      created_at: now,
    };
    const assistantMessage: AssistantMessageView = {
      message_id: ctx.assistantMessageId,
      role: "assistant",
      content: "当前没有可用的已激活报价规则，因此不会生成猜测价格。",
      sequence: ctx.assistantSequence,
      created_at: now,
      cited_evidence_ids: [],
    };
    const result = {
      contract_version: "1.0.0",
      turn_id: ctx.turnId,
      conversation_id: ctx.conversationId,
      client_message_id: ctx.clientMessageId,
      status: "COMPLETED",
      outcome: "safe_stop",
      stage: "QUALIFYING",
      user_message: userMessage,
      assistant_message: assistantMessage,
      question_fields: [],
      quote: null,
      warnings: ["no_active_rule"],
      replayed: false,
      completed_at: now,
    } satisfies ChatTurnResult;
    return [
      {
        contract_version: "1.0.0",
        event_id: uuid(),
        event_type: "turn.accepted",
        sequence: 1,
        conversation_id: ctx.conversationId,
        turn_id: ctx.turnId,
        emitted_at: now,
        payload: { client_message_id: ctx.clientMessageId, replayed: false },
      },
      {
        contract_version: "1.0.0",
        event_id: uuid(),
        event_type: "message.completed",
        sequence: 2,
        conversation_id: ctx.conversationId,
        turn_id: ctx.turnId,
        emitted_at: now,
        payload: { message: assistantMessage },
      },
      {
        contract_version: "1.0.0",
        event_id: uuid(),
        event_type: "turn.completed",
        sequence: 3,
        conversation_id: ctx.conversationId,
        turn_id: ctx.turnId,
        emitted_at: now,
        payload: { result },
      },
    ] satisfies ChatEvent[];
  };
}
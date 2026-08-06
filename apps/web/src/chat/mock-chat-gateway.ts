import {
  ChatEventSchema,
  ChatTurnResultSchema,
  ConversationSnapshotSchema,
  ConversationViewSchema,
  SendMessageRequestSchema,
  type AssistantMessageView,
  type ChatEvent,
  type ChatTurnResult,
  type ConversationStage,
  type ConversationView,
  type Intent,
  type IntentLevel,
  type NextAction,
  type SlotName,
} from "@crm-agent/contracts";
import { z } from "zod";
import {
  ChatGatewayError,
  type ChatGateway,
  type ConversationSnapshot,
  type SendMessageRequest,
} from "./chat-gateway";

const STORAGE_KEY = "crm-agent.d02.mock-gateway.v1";

const MockStoreSchema = z
  .object({
    conversations: z.record(z.string().uuid(), ConversationSnapshotSchema),
  })
  .strict();

type MockStore = z.output<typeof MockStoreSchema>;

interface Scenario {
  intent: Intent;
  valueLevel: IntentLevel;
  nextAction: NextAction;
  outcome: "answer" | "question" | "safe_stop";
  stage: ConversationStage;
  response: string;
  questionFields: SlotName[];
  warnings: string[];
}

export interface MockChatGatewayOptions {
  delayMs?: number;
}

const EMPTY_STORE: MockStore = { conversations: {} };

function createId() {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (character) => {
    const random = Math.floor(Math.random() * 16);
    const value = character === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

function chooseScenario(content: string): Scenario {
  if (/提示词|密钥|系统指令|底价/.test(content)) {
    return {
      intent: "risk",
      valueLevel: "unknown",
      nextAction: "safe_stop",
      outcome: "safe_stop",
      stage: "DISCOVERY",
      response: "我不能提供内部提示词、密钥或未公开规则，但可以继续协助合法的装修咨询。",
      questionFields: [],
      warnings: ["safe_stop"],
    };
  }

  if (/报价|预算|平米|㎡|装修/.test(content)) {
    return {
      intent: "quote_request",
      valueLevel: "medium",
      nextAction: "ask_missing_fields",
      outcome: "question",
      stage: "QUALIFYING",
      response: "已记录这次测试需求。为了继续评估，请先确认项目所在城市。",
      questionFields: ["city"],
      warnings: [],
    };
  }

  if (/环保|材料|售后|工期|知识/.test(content)) {
    return {
      intent: "consulting",
      valueLevel: "low",
      nextAction: "search_knowledge",
      outcome: "answer",
      stage: "DISCOVERY",
      response: "当前为模拟知识介入演示。真实企业材料、工期和售后说明需在后续接入已审核知识库后提供。",
      questionFields: [],
      warnings: ["knowledge_insufficient"],
    };
  }

  return {
    intent: "consulting",
    valueLevel: "low",
    nextAction: "answer_question",
    outcome: "answer",
    stage: "DISCOVERY",
    response: "可以先说明房屋面积、所在城市和希望了解的装修范围，我会继续整理测试需求。",
    questionFields: [],
    warnings: [],
  };
}

function splitResponse(response: string) {
  const midpoint = Math.max(1, Math.ceil(response.length / 2));
  return [response.slice(0, midpoint), response.slice(midpoint)].filter(Boolean);
}

export class MockChatGateway implements ChatGateway {
  private readonly delayMs: number;

  constructor(
    private readonly storage: Storage,
    options: MockChatGatewayOptions = {},
  ) {
    this.delayMs = options.delayMs ?? 90;
  }

  async createConversation(): Promise<ConversationView> {
    const now = new Date().toISOString();
    const conversation = ConversationViewSchema.parse({
      contract_version: "1.0.0",
      conversation_id: createId(),
      stage: "DISCOVERY",
      status: "ACTIVE",
      created_at: now,
      updated_at: now,
    });
    const snapshot = ConversationSnapshotSchema.parse({
      contract_version: "1.0.0",
      conversation,
      messages: [],
      current_quote: null,
      active_turn_id: null,
    });
    const store = this.readStore();
    store.conversations[conversation.conversation_id] = snapshot;
    this.writeStore(store);
    return conversation;
  }

  async getConversation(conversationId: string): Promise<ConversationSnapshot> {
    const snapshot = this.readStore().conversations[conversationId];
    if (!snapshot) {
      throw new ChatGatewayError("not_found", "没有找到该本地测试会话，请新建会话。 ");
    }
    return ConversationSnapshotSchema.parse(snapshot);
  }

  async deleteConversation(conversationId: string): Promise<void> {
    const store = this.readStore();
    delete store.conversations[conversationId];
    this.writeStore(store);
  }

  async *sendMessage(
    conversationId: string,
    candidate: SendMessageRequest,
  ): AsyncIterable<ChatEvent> {
    const request = SendMessageRequestSchema.parse(candidate);
    const snapshot = await this.getConversation(conversationId);
    const scenario = chooseScenario(request.content);
    const turnId = createId();
    const assistantMessageId = createId();
    const now = new Date().toISOString();
    const userMessage = {
      message_id: request.client_message_id,
      role: "user" as const,
      content: request.content,
      sequence: snapshot.messages.length + 1,
      created_at: now,
    };
    const assistantMessage: AssistantMessageView = {
      message_id: assistantMessageId,
      role: "assistant",
      content: scenario.response,
      sequence: snapshot.messages.length + 2,
      created_at: now,
      cited_evidence_ids: [],
    };
    const result: ChatTurnResult = ChatTurnResultSchema.parse({
      contract_version: "1.0.0",
      turn_id: turnId,
      conversation_id: conversationId,
      client_message_id: request.client_message_id,
      status: "COMPLETED",
      outcome: scenario.outcome,
      stage: scenario.stage,
      user_message: userMessage,
      assistant_message: assistantMessage,
      question_fields: scenario.questionFields,
      quote: null,
      warnings: scenario.warnings,
      replayed: false,
      completed_at: now,
    });

    const events: ChatEvent[] = [];
    const addEvent = (eventType: ChatEvent["event_type"], payload: unknown) => {
      events.push(
        ChatEventSchema.parse({
          contract_version: "1.0.0",
          event_id: createId(),
          event_type: eventType,
          sequence: events.length + 1,
          conversation_id: conversationId,
          turn_id: turnId,
          emitted_at: new Date().toISOString(),
          payload,
        }),
      );
    };

    addEvent("turn.accepted", {
      client_message_id: request.client_message_id,
      replayed: false,
    });
    addEvent("analysis.completed", {
      intent: scenario.intent,
      value_level: scenario.valueLevel,
      next_action: scenario.nextAction,
    });
    for (const [index, delta] of splitResponse(scenario.response).entries()) {
      addEvent("message.delta", { message_id: assistantMessageId, delta, index });
    }
    if (scenario.outcome === "question") {
      addEvent("question.required", {
        message: assistantMessage,
        question_fields: scenario.questionFields,
      });
    } else {
      addEvent("message.completed", { message: assistantMessage });
    }
    addEvent("turn.completed", { result });

    const store = this.readStore();
    store.conversations[conversationId] = ConversationSnapshotSchema.parse({
      ...snapshot,
      conversation: {
        ...snapshot.conversation,
        stage: scenario.stage,
        updated_at: now,
      },
      active_turn_id: turnId,
    });
    this.writeStore(store);

    for (const event of events) {
      if (this.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      if (event.event_type === "turn.completed") {
        const currentStore = this.readStore();
        currentStore.conversations[conversationId] = ConversationSnapshotSchema.parse({
          contract_version: "1.0.0",
          conversation: {
            ...snapshot.conversation,
            stage: scenario.stage,
            updated_at: now,
          },
          messages: [...snapshot.messages, result.user_message, result.assistant_message],
          current_quote: null,
          active_turn_id: null,
        });
        this.writeStore(currentStore);
      }
      yield event;
    }
  }

  private readStore(): MockStore {
    const raw = this.storage.getItem(STORAGE_KEY);
    if (!raw) return { ...EMPTY_STORE, conversations: {} };
    try {
      return MockStoreSchema.parse(JSON.parse(raw));
    } catch {
      throw new ChatGatewayError(
        "contract",
        "本地测试会话数据无法通过契约校验，请清理浏览器存储后重试。",
      );
    }
  }

  private writeStore(store: MockStore) {
    this.storage.setItem(STORAGE_KEY, JSON.stringify(MockStoreSchema.parse(store)));
  }
}

import {
  ChatEventSchema,
  ChatTurnResultSchema,
  ConversationSnapshotSchema,
  ConversationViewSchema,
  QuoteResultSchema,
  SendMessageRequestSchema,
  type AssistantMessageView,
  type ChatEvent,
  type ChatTurnResult,
  type ConversationStage,
  type ConversationView,
  type Intent,
  type IntentLevel,
  type NextAction,
  type QuoteResult,
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
  outcome: "answer" | "question" | "quote" | "safe_stop";
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

  if (/不可报价|无可用规则/.test(content)) {
    return {
      intent: "quote_request",
      valueLevel: "medium",
      nextAction: "prepare_quote",
      outcome: "answer",
      stage: "NEGOTIATION",
      response: "当前没有可用的已激活报价规则，因此不会生成猜测价格。",
      questionFields: [],
      warnings: ["no_active_rule"],
    };
  }

  if (/生成测试报价|出测试报价/.test(content)) {
    return {
      intent: "quote_request",
      valueLevel: "medium",
      nextAction: "prepare_quote",
      outcome: "quote",
      stage: "NEGOTIATION",
      response: "已生成本地测试预估报价。",
      questionFields: [],
      warnings: [],
    };
  }

  if (/调整测试报价|调整方案|降价/.test(content)) {
    return {
      intent: "plan_adjustment",
      valueLevel: "medium",
      nextAction: "adjust_quote",
      outcome: "quote",
      stage: "NEGOTIATION",
      response: "已根据最新偏好生成调整后的测试报价。",
      questionFields: [],
      warnings: [],
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
  private readonly conversationGenerations = new Map<string, number>();

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
    this.conversationGenerations.set(conversation.conversation_id, 0);
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
    this.advanceGeneration(conversationId);
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
    const generation = this.advanceGeneration(conversationId);
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
    const quote = scenario.outcome === "quote" ? this.buildQuote(conversationId, now, snapshot.current_quote) : null;
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
      quote: quote,
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
    } else if (scenario.outcome === "quote" && quote) {
      addEvent("quote.ready", { message: assistantMessage, quote });
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
        if (
          currentStore.conversations[conversationId] &&
          this.conversationGenerations.get(conversationId) === generation
        ) {
          currentStore.conversations[conversationId] = ConversationSnapshotSchema.parse({
            contract_version: "1.0.0",
            conversation: {
              ...snapshot.conversation,
              stage: scenario.stage,
              updated_at: now,
            },
            messages: [...snapshot.messages, result.user_message, result.assistant_message],
            current_quote: quote,
            active_turn_id: null,
          });
          this.writeStore(currentStore);
        }
      }
      yield event;
    }
  }

  private buildQuote(conversationId: string, now: string, currentQuote: QuoteResult | null): QuoteResult {
    const previous = currentQuote;
    const unitPriceFen = previous ? 118_000 : 128_000;
    const areaSqm = 90;
    const amountFen = unitPriceFen * areaSqm;
    const ruleVersionId = createId();
    return QuoteResultSchema.parse({
      contract_version: "1.0.0",
      quote_id: createId(),
      conversation_id: conversationId,
      quote_version: previous ? previous.quote_version + 1 : 1,
      parent_quote_id: previous ? previous.quote_id : null,
      status: "estimated",
      currency: "CNY",
      parameters_snapshot: {
        city: "默认测试城市",
        area_sqm: areaSqm,
        house_state: "old_renovation",
        service_scope: "whole_home",
        material_tier: "mid",
        quantities: {},
        special_requirements: [],
      },
      items: [
        {
          quote_item_id: createId(),
          category: "construction",
          label: previous ? "全屋施工测试项（调整）" : "全屋施工测试项",
          calculation_type: "AREA_MULTIPLY",
          quantity: areaSqm,
          unit: "sqm",
          unit_price_fen: unitPriceFen,
          amount_fen: amountFen,
          calculation_inputs: { area_sqm: areaSqm, unit_price_fen: unitPriceFen },
          rule_ref: {
            rule_id: "RULE-WHOLE-MID-001",
            rule_version_id: ruleVersionId,
            version: 1,
          },
        },
      ],
      estimated_total_fen: amountFen,
      rule_versions: [
        {
          rule_id: "RULE-WHOLE-MID-001",
          rule_version_id: ruleVersionId,
          version: 1,
        },
      ],
      knowledge_evidence_ids: [createId()],
      assumptions: ["仅用于本地验证"],
      exclusions: ["不包含正式量房后的变更"],
      disclaimer: "本结果为测试预估，最终以量房、施工方案和正式合同为准。",
      created_at: now,
    });
  }

  private advanceGeneration(conversationId: string) {
    const generation = (this.conversationGenerations.get(conversationId) ?? 0) + 1;
    this.conversationGenerations.set(conversationId, generation);
    return generation;
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
import type {
  ApiError,
  AssistantMessageView,
  ChatEvent,
  ChatTurnResult,
} from "@crm-agent/contracts";
import { ids, validChatTurnResult, validQuoteResult, validUserMessage } from "./contracts";

export const webFixtureIds = {
  clearedConversation: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  questionAssistantMessage: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  knowledgeAssistantMessage: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
  quoteUnavailableAssistantMessage: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  failureRequest: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  events: {
    quoteAccepted: "90000000-0000-4000-8000-000000000001",
    quoteAnalysis: "90000000-0000-4000-8000-000000000002",
    quoteDelta: "90000000-0000-4000-8000-000000000003",
    quoteReady: "90000000-0000-4000-8000-000000000004",
    quoteCompleted: "90000000-0000-4000-8000-000000000005",
    questionAccepted: "91000000-0000-4000-8000-000000000001",
    questionAnalysis: "91000000-0000-4000-8000-000000000002",
    questionRequired: "91000000-0000-4000-8000-000000000003",
    questionCompleted: "91000000-0000-4000-8000-000000000004",
    failureAccepted: "92000000-0000-4000-8000-000000000001",
    failureTerminal: "92000000-0000-4000-8000-000000000002",
    knowledgeAccepted: "93000000-0000-4000-8000-000000000001",
    knowledgeMessage: "93000000-0000-4000-8000-000000000002",
    knowledgeCompleted: "93000000-0000-4000-8000-000000000003",
    quoteUnavailableAccepted: "94000000-0000-4000-8000-000000000001",
    quoteUnavailableMessage: "94000000-0000-4000-8000-000000000002",
    quoteUnavailableCompleted: "94000000-0000-4000-8000-000000000003",
  },
} as const;

const questionAssistantMessage = {
  message_id: webFixtureIds.questionAssistantMessage,
  role: "assistant",
  content: "为了生成预估报价，请确认希望使用的材料档位。",
  sequence: 2,
  created_at: "2026-08-05T06:00:02Z",
  cited_evidence_ids: [],
} satisfies AssistantMessageView;

export const validQuestionTurnResult = {
  contract_version: "1.0.0",
  turn_id: ids.turn,
  conversation_id: ids.conversation,
  client_message_id: ids.userMessage,
  status: "COMPLETED",
  outcome: "question",
  stage: "QUALIFYING",
  user_message: validUserMessage,
  assistant_message: questionAssistantMessage,
  question_fields: ["material_tier"],
  quote: null,
  warnings: [],
  replayed: false,
  completed_at: "2026-08-05T06:00:02Z",
} satisfies ChatTurnResult;

export const quoteReadyEventStream = [
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteAccepted,
    event_type: "turn.accepted",
    sequence: 1,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:01Z",
    payload: { client_message_id: ids.userMessage, replayed: false },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteAnalysis,
    event_type: "analysis.completed",
    sequence: 2,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:02Z",
    payload: {
      intent: "quote_request",
      value_level: "medium",
      next_action: "prepare_quote",
    },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteDelta,
    event_type: "message.delta",
    sequence: 3,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:02Z",
    payload: {
      message_id: ids.assistantMessage,
      delta: "已生成本地测试预估报价。",
      index: 0,
    },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteReady,
    event_type: "quote.ready",
    sequence: 4,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:03Z",
    payload: {
      message: validChatTurnResult.assistant_message,
      quote: validQuoteResult,
    },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteCompleted,
    event_type: "turn.completed",
    sequence: 5,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:04Z",
    payload: { result: validChatTurnResult },
  },
] satisfies ChatEvent[];

export const questionRequiredEventStream = [
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.questionAccepted,
    event_type: "turn.accepted",
    sequence: 1,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:01Z",
    payload: { client_message_id: ids.userMessage, replayed: false },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.questionAnalysis,
    event_type: "analysis.completed",
    sequence: 2,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:01Z",
    payload: {
      intent: "quote_request",
      value_level: "medium",
      next_action: "ask_missing_fields",
    },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.questionRequired,
    event_type: "question.required",
    sequence: 3,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:02Z",
    payload: {
      message: questionAssistantMessage,
      question_fields: ["material_tier"],
    },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.questionCompleted,
    event_type: "turn.completed",
    sequence: 4,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:03Z",
    payload: { result: validQuestionTurnResult },
  },
] satisfies ChatEvent[];

export const aiOutputInvalidError = {
  contract_version: "1.0.0",
  error: {
    code: "AI_OUTPUT_INVALID",
    message: "回复生成失败，请稍后重试。",
    retryable: true,
    request_id: webFixtureIds.failureRequest,
    details: { safe_reason: "schema_validation_failed" },
  },
} satisfies ApiError;

export const failedEventStream = [
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.failureAccepted,
    event_type: "turn.accepted",
    sequence: 1,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:01Z",
    payload: { client_message_id: ids.userMessage, replayed: false },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.failureTerminal,
    event_type: "turn.failed",
    sequence: 2,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:02Z",
    payload: { error: aiOutputInvalidError.error },
  },
] satisfies ChatEvent[];

const knowledgeInsufficientAssistantMessage = {
  message_id: webFixtureIds.knowledgeAssistantMessage,
  role: "assistant",
  content: "当前知识证据不足，暂时无法提供可靠说明或价格。",
  sequence: 2,
  created_at: "2026-08-05T06:00:02Z",
  cited_evidence_ids: [],
} satisfies AssistantMessageView;

export const knowledgeInsufficientTurnResult = {
  contract_version: "1.0.0",
  turn_id: ids.turn,
  conversation_id: ids.conversation,
  client_message_id: ids.userMessage,
  status: "COMPLETED",
  outcome: "answer",
  stage: "QUALIFYING",
  user_message: validUserMessage,
  assistant_message: knowledgeInsufficientAssistantMessage,
  question_fields: [],
  quote: null,
  warnings: ["knowledge_insufficient"],
  replayed: false,
  completed_at: "2026-08-05T06:00:03Z",
} satisfies ChatTurnResult;

export const knowledgeInsufficientEventStream = [
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.knowledgeAccepted,
    event_type: "turn.accepted",
    sequence: 1,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:01Z",
    payload: { client_message_id: ids.userMessage, replayed: false },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.knowledgeMessage,
    event_type: "message.completed",
    sequence: 2,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:02Z",
    payload: { message: knowledgeInsufficientAssistantMessage },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.knowledgeCompleted,
    event_type: "turn.completed",
    sequence: 3,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:03Z",
    payload: { result: knowledgeInsufficientTurnResult },
  },
] satisfies ChatEvent[];

const quoteUnavailableAssistantMessage = {
  message_id: webFixtureIds.quoteUnavailableAssistantMessage,
  role: "assistant",
  content: "当前没有可用的已激活报价规则，因此不会生成猜测价格。",
  sequence: 2,
  created_at: "2026-08-05T06:00:02Z",
  cited_evidence_ids: [],
} satisfies AssistantMessageView;

export const quoteUnavailableTurnResult = {
  contract_version: "1.0.0",
  turn_id: ids.turn,
  conversation_id: ids.conversation,
  client_message_id: ids.userMessage,
  status: "COMPLETED",
  outcome: "safe_stop",
  stage: "QUALIFYING",
  user_message: validUserMessage,
  assistant_message: quoteUnavailableAssistantMessage,
  question_fields: [],
  quote: null,
  warnings: ["no_active_rule"],
  replayed: false,
  completed_at: "2026-08-05T06:00:03Z",
} satisfies ChatTurnResult;

export const quoteUnavailableEventStream = [
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteUnavailableAccepted,
    event_type: "turn.accepted",
    sequence: 1,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:01Z",
    payload: { client_message_id: ids.userMessage, replayed: false },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteUnavailableMessage,
    event_type: "message.completed",
    sequence: 2,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:02Z",
    payload: { message: quoteUnavailableAssistantMessage },
  },
  {
    contract_version: "1.0.0",
    event_id: webFixtureIds.events.quoteUnavailableCompleted,
    event_type: "turn.completed",
    sequence: 3,
    conversation_id: ids.conversation,
    turn_id: ids.turn,
    emitted_at: "2026-08-05T06:00:03Z",
    payload: { result: quoteUnavailableTurnResult },
  },
] satisfies ChatEvent[];

export const emptyConversationSnapshot = {
  contract_version: "1.0.0",
  conversation: {
    contract_version: "1.0.0",
    conversation_id: ids.conversation,
    stage: "DISCOVERY",
    status: "ACTIVE",
    created_at: "2026-08-05T06:00:00Z",
    updated_at: "2026-08-05T06:00:00Z",
  },
  messages: [],
  current_quote: null,
  active_turn_id: null,
} as const;

export const restoredQuoteConversationSnapshot = {
  contract_version: "1.0.0",
  conversation: {
    contract_version: "1.0.0",
    conversation_id: ids.conversation,
    stage: "NEGOTIATION",
    status: "ACTIVE",
    created_at: "2026-08-05T06:00:00Z",
    updated_at: "2026-08-05T06:00:04Z",
  },
  messages: [validUserMessage, validChatTurnResult.assistant_message],
  current_quote: validQuoteResult,
  active_turn_id: null,
} as const;

export const clearedConversationSnapshot = {
  contract_version: "1.0.0",
  conversation: {
    contract_version: "1.0.0",
    conversation_id: webFixtureIds.clearedConversation,
    stage: "DISCOVERY",
    status: "ACTIVE",
    created_at: "2026-08-05T06:05:00Z",
    updated_at: "2026-08-05T06:05:00Z",
  },
  messages: [],
  current_quote: null,
  active_turn_id: null,
} as const;

export const networkFailureState = {
  kind: "network_error",
  user_safe_message: "暂时无法连接本地服务，请检查服务状态后重试。",
  retryable: true,
} as const;

export const webStateFixtures = {
  empty: { snapshot: emptyConversationSnapshot, events: [] },
  cleared: {
    previousSnapshot: restoredQuoteConversationSnapshot,
    snapshot: clearedConversationSnapshot,
    events: [],
  },
  loading: { snapshot: emptyConversationSnapshot, events: quoteReadyEventStream.slice(0, 1) },
  missingFields: { snapshot: emptyConversationSnapshot, events: questionRequiredEventStream },
  quoteReady: { snapshot: restoredQuoteConversationSnapshot, events: quoteReadyEventStream },
  knowledgeInsufficient: {
    snapshot: emptyConversationSnapshot,
    events: knowledgeInsufficientEventStream,
  },
  quoteUnavailable: { snapshot: emptyConversationSnapshot, events: quoteUnavailableEventStream },
  schemaFailure: { snapshot: emptyConversationSnapshot, events: failedEventStream },
  networkFailure: { snapshot: emptyConversationSnapshot, error: networkFailureState },
} as const;

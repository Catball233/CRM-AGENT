import {
  ChatEventSchema,
  type AssistantMessageView,
  type ChatEvent,
  type ChatTurnResult,
} from "@crm-agent/contracts";
import type { z } from "zod";
import { ChatGatewayError } from "./chat-gateway";

export type AnalysisSummary = Extract<
  ChatEvent,
  { event_type: "analysis.completed" }
>["payload"];

type TerminalError = Extract<ChatEvent, { event_type: "turn.failed" }>["payload"]["error"];

export interface ChatStreamState {
  conversationId: string;
  turnId: string | null;
  lastSequence: number;
  nextDeltaIndex: number;
  accepted: boolean;
  terminal: "completed" | "failed" | null;
  responseCommitted: boolean;
  streamedText: string;
  analysis: AnalysisSummary | null;
  assistantMessage: AssistantMessageView | null;
  result: ChatTurnResult | null;
  error: TerminalError | null;
}

export function createChatStreamState(conversationId: string): ChatStreamState {
  return {
    conversationId,
    turnId: null,
    lastSequence: 0,
    nextDeltaIndex: 0,
    accepted: false,
    terminal: null,
    responseCommitted: false,
    streamedText: "",
    analysis: null,
    assistantMessage: null,
    result: null,
    error: null,
  };
}

function protocolError(message: string): never {
  throw new ChatGatewayError("contract", `模拟事件契约无效：${message}`);
}

export function reduceChatEvent(
  state: ChatStreamState,
  candidate: unknown,
): ChatStreamState {
  let event: z.output<typeof ChatEventSchema>;
  try {
    event = ChatEventSchema.parse(candidate);
  } catch {
    return protocolError("事件结构无法解析");
  }

  if (state.terminal) return protocolError("终止事件之后仍收到新事件");
  if (event.conversation_id !== state.conversationId) {
    return protocolError("事件不属于当前会话");
  }
  if (state.lastSequence === 0 && event.event_type !== "turn.accepted") {
    return protocolError("首个事件不是 turn.accepted");
  }
  if (event.sequence !== state.lastSequence + 1) {
    return protocolError("事件序号不连续");
  }
  if (state.turnId !== null && event.turn_id !== state.turnId) {
    return protocolError("同一事件流出现多个 turn_id");
  }

  const next: ChatStreamState = {
    ...state,
    turnId: state.turnId ?? event.turn_id,
    lastSequence: event.sequence,
  };

  switch (event.event_type) {
    case "turn.accepted":
      if (state.accepted) return protocolError("重复接收 turn.accepted");
      return { ...next, accepted: true };
    case "analysis.completed":
      if (!state.accepted) return protocolError("分析事件早于接收事件");
      if (state.analysis) return protocolError("重复接收分析事件");
      if (state.responseCommitted) return protocolError("回复完成后仍收到分析事件");
      return { ...next, analysis: event.payload };
    case "message.delta":
      if (state.responseCommitted) return protocolError("回复完成后仍收到消息增量");
      if (event.payload.index !== state.nextDeltaIndex) {
        return protocolError("消息增量索引不连续");
      }
      return {
        ...next,
        nextDeltaIndex: state.nextDeltaIndex + 1,
        streamedText: state.streamedText + event.payload.delta,
      };
    case "question.required":
    case "message.completed":
      if (state.responseCommitted) return protocolError("同一事件流出现多个完整回复");
      return {
        ...next,
        responseCommitted: true,
        assistantMessage: event.payload.message,
      };
    case "quote.ready":
      if (state.responseCommitted) return protocolError("同一事件流出现多个完整回复");
      return {
        ...next,
        responseCommitted: true,
        assistantMessage: event.payload.message,
      };
    case "turn.completed":
      if (
        event.payload.result.turn_id !== event.turn_id ||
        event.payload.result.conversation_id !== event.conversation_id
      ) {
        return protocolError("终止结果与事件会话不一致");
      }
      return {
        ...next,
        terminal: "completed",
        result: event.payload.result,
        assistantMessage: event.payload.result.assistant_message,
      };
    case "turn.failed":
      return { ...next, terminal: "failed", error: event.payload.error };
  }
}

export function assertTerminalStream(state: ChatStreamState) {
  if (!state.accepted || !state.terminal) {
    protocolError("事件流未包含唯一终止事件");
  }
  return state;
}

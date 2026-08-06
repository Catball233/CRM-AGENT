import { describe, expect, it } from "vitest";
import {
  failedEventStream,
  knowledgeInsufficientEventStream,
  questionRequiredEventStream,
  quoteReadyEventStream,
  quoteUnavailableEventStream,
} from "@crm-agent/test-fixtures";
import {
  assertTerminalStream,
  createChatStreamState,
  reduceChatEvent,
} from "./chat-event-reducer";

function consume(events: readonly unknown[]) {
  const first = events[0] as { conversation_id: string };
  let state = createChatStreamState(first.conversation_id);
  for (const event of events) state = reduceChatEvent(state, event);
  return state;
}

describe("D-02 chat event reducer", () => {
  it("consumes the D-01 quote stream without rendering quote details", () => {
    const state = assertTerminalStream(consume(quoteReadyEventStream));

    expect(state.terminal).toBe("completed");
    expect(state.analysis?.intent).toBe("quote_request");
    expect(state.streamedText).toBe("已生成本地测试预估报价。");
    expect(state.assistantMessage?.content).toBe("已生成本地测试预估报价。");
  });

  it("consumes question and failed terminal states", () => {
    const question = assertTerminalStream(consume(questionRequiredEventStream));
    const failed = assertTerminalStream(consume(failedEventStream));

    expect(question.result?.question_fields).toEqual(["material_tier"]);
    expect(failed.terminal).toBe("failed");
    expect(failed.error?.code).toBe("AI_OUTPUT_INVALID");
  });

  it("preserves no-knowledge and no-active-rule outcomes without inventing data", () => {
    const knowledge = assertTerminalStream(consume(knowledgeInsufficientEventStream));
    const unavailableQuote = assertTerminalStream(consume(quoteUnavailableEventStream));

    expect(knowledge.result?.warnings).toContain("knowledge_insufficient");
    expect(knowledge.assistantMessage?.content).toContain("知识证据不足");
    expect(unavailableQuote.result?.warnings).toContain("no_active_rule");
    expect(unavailableQuote.result?.quote).toBeNull();
  });

  it("rejects an event stream that does not start with turn.accepted", () => {
    const first = quoteReadyEventStream[0]!;
    const state = createChatStreamState(first.conversation_id);

    expect(() => reduceChatEvent(state, quoteReadyEventStream[1])).toThrow(
      "首个事件不是 turn.accepted",
    );
  });

  it("rejects sequence gaps, malformed events and events after a terminal event", () => {
    const first = quoteReadyEventStream[0]!;
    const accepted = reduceChatEvent(createChatStreamState(first.conversation_id), first);
    const terminal = consume(quoteReadyEventStream);

    expect(() =>
      reduceChatEvent(accepted, { ...quoteReadyEventStream[1], sequence: 4 }),
    ).toThrow("事件序号不连续");
    expect(() => reduceChatEvent(accepted, { event_type: "analysis.completed" })).toThrow(
      "事件结构无法解析",
    );
    expect(() => reduceChatEvent(terminal, quoteReadyEventStream.at(-1))).toThrow(
      "终止事件之后仍收到新事件",
    );
  });

  it("rejects a stream without a terminal event", () => {
    const state = consume(quoteReadyEventStream.slice(0, -1));
    expect(() => assertTerminalStream(state)).toThrow("事件流未包含唯一终止事件");
  });

  it("rejects deltas after a complete response and mismatched terminal results", () => {
    let questionState = createChatStreamState(questionRequiredEventStream[0]!.conversation_id);
    for (const event of questionRequiredEventStream.slice(0, -1)) {
      questionState = reduceChatEvent(questionState, event);
    }
    const extraDelta = {
      ...quoteReadyEventStream[2],
      conversation_id: questionRequiredEventStream[0]!.conversation_id,
      turn_id: questionRequiredEventStream[0]!.turn_id,
      sequence: questionState.lastSequence + 1,
    };

    expect(() => reduceChatEvent(questionState, extraDelta)).toThrow(
      "回复完成后仍收到消息增量",
    );

    const beforeTerminal = consume(quoteReadyEventStream.slice(0, -1));
    const terminal = quoteReadyEventStream.at(-1)!;
    expect(() =>
      reduceChatEvent(beforeTerminal, {
        ...terminal,
        payload: {
          result: {
            ...terminal.payload.result,
            conversation_id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
          },
        },
      }),
    ).toThrow("终止结果与事件会话不一致");
  });

  it("rejects cross-request and cross-message event mixing", () => {
    const first = quoteReadyEventStream[0]!;
    const wrongClientMessageId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
    const requestState = createChatStreamState(
      first.conversation_id,
      wrongClientMessageId,
    );

    expect(() => reduceChatEvent(requestState, first)).toThrow(
      "接收事件与当前请求不一致",
    );

    const beforeComplete = consume(quoteReadyEventStream.slice(0, 3));
    const quoteReady = quoteReadyEventStream[3]!;
    expect(() =>
      reduceChatEvent(beforeComplete, {
        ...quoteReady,
        payload: {
          ...quoteReady.payload,
          message: {
            ...quoteReady.payload.message,
            message_id: wrongClientMessageId,
          },
        },
      }),
    ).toThrow("完整回复与消息增量不一致");
  });
});

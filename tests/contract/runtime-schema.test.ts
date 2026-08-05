import { describe, expect, it } from "vitest";
import {
  AnalysisResultSchema,
  ChatEventSchema,
  ChatTurnResultSchema,
  ContextBundleSchema,
  KnowledgeEvidenceSchema,
  QuoteResultSchema,
  RuleDefinitionSchema,
  SendMessageRequestSchema,
} from "../../packages/contracts/src";
import {
  ids,
  invalidFixtures,
  validAnalysisResult,
  validChatTurnResult,
  validContextBundle,
  validKnowledgeEvidence,
  validQuoteResult,
} from "../../packages/test-fixtures/src";

describe("runtime contract schemas", () => {
  it("accepts the canonical AI analysis fixture", () => {
    expect(AnalysisResultSchema.safeParse(validAnalysisResult).success).toBe(true);
  });

  it("separates intent from customer value", () => {
    expect(AnalysisResultSchema.safeParse(invalidFixtures.unsupportedIntent).success).toBe(false);
  });

  it("requires customer-message evidence for known value levels", () => {
    expect(AnalysisResultSchema.safeParse(invalidFixtures.valueWithoutEvidence).success).toBe(false);
  });

  it("rejects unknown AI output fields", () => {
    expect(AnalysisResultSchema.safeParse(invalidFixtures.unknownAnalysisField).success).toBe(false);
  });

  it("accepts context and knowledge evidence fixtures", () => {
    expect(ContextBundleSchema.safeParse(validContextBundle).success).toBe(true);
    expect(KnowledgeEvidenceSchema.safeParse(validKnowledgeEvidence).success).toBe(true);
  });

  it("checks that quote totals equal item totals", () => {
    expect(QuoteResultSchema.safeParse(validQuoteResult).success).toBe(true);
    expect(QuoteResultSchema.safeParse(invalidFixtures.incorrectQuoteTotal).success).toBe(false);
  });

  it("enforces quote presence for quote outcomes", () => {
    expect(ChatTurnResultSchema.safeParse(validChatTurnResult).success).toBe(true);
    expect(
      ChatTurnResultSchema.safeParse({ ...validChatTurnResult, quote: null }).success,
    ).toBe(false);
  });

  it("validates discriminated SSE event payloads", () => {
    const event = {
      contract_version: "1.0.0",
      event_id: ids.event,
      event_type: "turn.completed",
      sequence: 2,
      conversation_id: ids.conversation,
      turn_id: ids.turn,
      emitted_at: "2026-08-05T06:00:04Z",
      payload: { result: validChatTurnResult },
    };

    expect(ChatEventSchema.safeParse(event).success).toBe(true);
    expect(ChatEventSchema.safeParse({ ...event, payload: {} }).success).toBe(false);
  });

  it("rejects extra HTTP request fields", () => {
    const request = {
      contract_version: "1.0.0",
      client_message_id: ids.userMessage,
      content: "测试消息",
      response_mode: "complete",
      injected: true,
    };

    expect(SendMessageRequestSchema.safeParse(request).success).toBe(false);
  });

  it("requires formula-specific rule inputs", () => {
    const invalidRule = {
      rule_id: "RULE-AREA-001",
      version: 1,
      city: "默认测试城市",
      calculation_type: "AREA_MULTIPLY",
      conditions: {},
      effective_from: "2026-08-05T00:00:00Z",
    };

    expect(RuleDefinitionSchema.safeParse(invalidRule).success).toBe(false);
  });
});

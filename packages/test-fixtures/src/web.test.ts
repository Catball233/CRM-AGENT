import { describe, expect, it } from "vitest";
import {
  ApiErrorSchema,
  ChatEventSchema,
  ConversationSnapshotSchema,
} from "@crm-agent/contracts";
import {
  aiOutputInvalidError,
  clearedConversationSnapshot,
  emptyConversationSnapshot,
  failedEventStream,
  knowledgeInsufficientEventStream,
  knowledgeInsufficientTurnResult,
  questionRequiredEventStream,
  quoteUnavailableEventStream,
  quoteUnavailableTurnResult,
  quoteReadyEventStream,
  restoredQuoteConversationSnapshot,
  webStateFixtures,
} from "./web";

const eventStreams = [
  quoteReadyEventStream,
  questionRequiredEventStream,
  knowledgeInsufficientEventStream,
  quoteUnavailableEventStream,
  failedEventStream,
];

describe("D-01 web state fixtures", () => {
  it("uses only contract-valid conversation snapshots", () => {
    expect(ConversationSnapshotSchema.safeParse(emptyConversationSnapshot).success).toBe(true);
    expect(ConversationSnapshotSchema.safeParse(clearedConversationSnapshot).success).toBe(true);
    expect(ConversationSnapshotSchema.safeParse(restoredQuoteConversationSnapshot).success).toBe(
      true,
    );
  });

  it("uses only contract-valid chat events", () => {
    for (const stream of eventStreams) {
      for (const event of stream) {
        expect(ChatEventSchema.safeParse(event).success).toBe(true);
      }
    }
  });

  it("keeps every simulated stream ordered and terminal", () => {
    for (const stream of eventStreams) {
      expect(stream[0]?.event_type).toBe("turn.accepted");
      expect(stream.map((event) => event.sequence)).toEqual(
        stream.map((_, index) => index + 1),
      );

      const terminalEvents = stream.filter(
        (event) => event.event_type === "turn.completed" || event.event_type === "turn.failed",
      );
      expect(terminalEvents).toHaveLength(1);
      expect(stream.at(-1)).toBe(terminalEvents[0]);
    }
  });

  it("provides quote, safe-degradation and schema-failure terminal states", () => {
    expect(quoteReadyEventStream.at(-1)?.event_type).toBe("turn.completed");
    expect(questionRequiredEventStream.at(-1)?.event_type).toBe("turn.completed");
    expect(knowledgeInsufficientEventStream.at(-1)?.event_type).toBe("turn.completed");
    expect(quoteUnavailableEventStream.at(-1)?.event_type).toBe("turn.completed");
    expect(failedEventStream.at(-1)?.event_type).toBe("turn.failed");
    expect(ApiErrorSchema.safeParse(aiOutputInvalidError).success).toBe(true);
  });

  it("provides the quote-card fields required by D-01", () => {
    const quote = restoredQuoteConversationSnapshot.current_quote;

    expect(quote.items.length).toBeGreaterThan(0);
    expect(quote.estimated_total_fen).toBeGreaterThan(0);
    expect(quote.rule_versions.length).toBeGreaterThan(0);
    expect(quote.assumptions.length).toBeGreaterThan(0);
    expect(quote.disclaimer.length).toBeGreaterThan(0);
  });

  it("keeps safe degradation distinct from a successful quote", () => {
    expect(knowledgeInsufficientTurnResult.warnings).toContain("knowledge_insufficient");
    expect(knowledgeInsufficientTurnResult.quote).toBeNull();
    expect(quoteUnavailableTurnResult.warnings).toContain("no_active_rule");
    expect(quoteUnavailableTurnResult.quote).toBeNull();
  });

  it("represents clearing an existing test conversation", () => {
    const clearedState = webStateFixtures.cleared;

    expect(clearedState.previousSnapshot.messages.length).toBeGreaterThan(0);
    expect(clearedState.previousSnapshot.current_quote).not.toBeNull();
    expect(clearedState.snapshot.conversation.conversation_id).not.toBe(
      clearedState.previousSnapshot.conversation.conversation_id,
    );
    expect(clearedState.snapshot.messages).toEqual([]);
    expect(clearedState.snapshot.current_quote).toBeNull();
    expect(clearedState.snapshot.active_turn_id).toBeNull();
  });

  it("provides every page state required by D-01", () => {
    expect(Object.keys(webStateFixtures)).toEqual([
      "empty",
      "cleared",
      "loading",
      "missingFields",
      "quoteReady",
      "knowledgeInsufficient",
      "quoteUnavailable",
      "schemaFailure",
      "networkFailure",
    ]);
  });
});

import { describe, expect, it } from "vitest";
import {
  type ConversationStage,
  AnalysisRequestSchema,
  AnalysisResultSchema,
  ContextBundleSchema,
  MemoryMutationPlanSchema,
} from "../../packages/contracts/src";
import {
  aiMemoryScenarioFixtures,
  aiMemoryIds,
  invalidAiMemoryFixtures,
} from "../../packages/test-fixtures/src";

const expectedFixtureIds = [
  "B-01-CONSULTING-NORMAL",
  "B-01-QUOTE-MISSING-CITY",
  "B-01-UNCLEAR-MISSING-CONTEXT",
  "B-01-INFERRED-MATERIAL-PREFERENCE",
  "B-01-BUDGET-CONFLICT",
  "B-01-LONG-TERM-RECALL",
  "B-01-PROMPT-INJECTION",
] as const;

const expectedStageRecommendations = [
  ["B-01-CONSULTING-NORMAL", "DISCOVERY"],
  ["B-01-QUOTE-MISSING-CITY", "QUALIFYING"],
  ["B-01-UNCLEAR-MISSING-CONTEXT", "DISCOVERY"],
  ["B-01-INFERRED-MATERIAL-PREFERENCE", "QUALIFYING"],
  ["B-01-BUDGET-CONFLICT", "QUALIFYING"],
  ["B-01-LONG-TERM-RECALL", "DISCOVERY"],
  ["B-01-PROMPT-INJECTION", "CLOSED"],
] as const satisfies ReadonlyArray<readonly [(typeof expectedFixtureIds)[number], ConversationStage]>;

const entityConversationIds = new Map<string, string>();
for (const ids of Object.values(aiMemoryIds)) {
  for (const entityId of Object.values(ids)) {
    entityConversationIds.set(entityId, ids.conversation);
  }
}

const collectFixtureEntityIds = (fixture: (typeof aiMemoryScenarioFixtures)[number]) => {
  const ids = new Set<string>();
  const context = fixture.analysis_request.context;
  const analysis = fixture.expected_analysis;
  const plan = fixture.expected_memory_plan;
  const addSourceRefs = (references: Array<{ source_id: string }>) => {
    for (const reference of references) ids.add(reference.source_id);
  };
  const addFacts = (facts: typeof context.confirmed_facts) => {
    for (const fact of facts) {
      ids.add(fact.fact_id);
      addSourceRefs(fact.source_refs);
    }
  };

  ids.add(fixture.analysis_request.turn_id);
  ids.add(fixture.analysis_request.current_message.message_id);
  for (const message of context.recent_messages) ids.add(message.message_id);
  addFacts(context.confirmed_facts);
  addFacts(context.inferred_facts);
  addFacts(context.conflicted_facts);
  if (context.memory_summary) {
    ids.add(context.memory_summary.summary_id);
    for (const messageId of context.memory_summary.source_message_ids) ids.add(messageId);
  }
  if (context.current_quote) ids.add(context.current_quote.quote_id);
  for (const item of context.recalled_items) ids.add(item.source_ref.source_id);

  addSourceRefs(analysis.value_assessment.evidence_refs);
  for (const concern of analysis.concerns) addSourceRefs(concern.evidence_refs);
  for (const update of analysis.slot_updates) {
    addSourceRefs(update.source_refs);
    for (const factId of update.conflicts_with_fact_ids ?? []) ids.add(factId);
  }
  for (const flag of analysis.safety_flags) addSourceRefs(flag.evidence_refs);

  ids.add(plan.turn_id);
  addFacts(plan.fact_upserts);
  for (const factId of plan.fact_ids_to_mark_conflicted) ids.add(factId);
  if (plan.summary_upsert) {
    ids.add(plan.summary_upsert.summary_id);
    for (const messageId of plan.summary_upsert.source_message_ids) ids.add(messageId);
  }

  return ids;
};

const hasOnlySameConversationEntities = (fixture: (typeof aiMemoryScenarioFixtures)[number]) => {
  const conversationId = fixture.analysis_request.conversation_id;
  return [...collectFixtureEntityIds(fixture)].every(
    (entityId) => entityConversationIds.get(entityId) === conversationId,
  );
};

const collectEvidenceSourceIds = (fixture: (typeof aiMemoryScenarioFixtures)[number]) => {
  const analysis = fixture.expected_analysis;
  const ids = new Set<string>();

  for (const reference of analysis.value_assessment.evidence_refs) ids.add(reference.source_id);
  for (const concern of analysis.concerns) {
    for (const reference of concern.evidence_refs) ids.add(reference.source_id);
  }
  for (const update of analysis.slot_updates) {
    for (const reference of update.source_refs) ids.add(reference.source_id);
  }
  for (const flag of analysis.safety_flags) {
    for (const reference of flag.evidence_refs) ids.add(reference.source_id);
  }
  for (const fact of fixture.analysis_request.context.confirmed_facts) {
    for (const reference of fact.source_refs) ids.add(reference.source_id);
  }
  for (const item of fixture.analysis_request.context.recalled_items) {
    ids.add(item.source_ref.source_id);
  }

  return ids;
};

describe("B-01 AI and memory fixtures", () => {
  it("parses every reusable input and expected output with public runtime schemas", () => {
    for (const fixture of aiMemoryScenarioFixtures) {
      expect(AnalysisRequestSchema.safeParse(fixture.analysis_request).success, fixture.fixture_id).toBe(
        true,
      );
      expect(ContextBundleSchema.safeParse(fixture.analysis_request.context).success, fixture.fixture_id).toBe(
        true,
      );
      expect(AnalysisResultSchema.safeParse(fixture.expected_analysis).success, fixture.fixture_id).toBe(
        true,
      );
      expect(
        MemoryMutationPlanSchema.safeParse(fixture.expected_memory_plan).success,
        fixture.fixture_id,
      ).toBe(true);
    }
  });

  it("covers normal, missing, conflict and exceptional behavior", () => {
    const fixtureIds = aiMemoryScenarioFixtures.map((fixture) => fixture.fixture_id);
    expect(fixtureIds).toHaveLength(expectedFixtureIds.length);
    expect(new Set(fixtureIds)).toEqual(new Set(expectedFixtureIds));
    expect(new Set(aiMemoryScenarioFixtures.map((fixture) => fixture.kind))).toEqual(
      new Set(["normal", "missing", "conflict", "exceptional"]),
    );

    const tags = new Set(aiMemoryScenarioFixtures.flatMap((fixture) => fixture.annotation.evaluation_tags));
    for (const requiredTag of [
      "intent:consulting",
      "intent:quote_request",
      "intent:unclear",
      "memory:confirmed-facts",
      "memory:inferred-fact",
      "memory:conflict",
      "memory:long-term-recall",
      "safety:prompt_injection",
    ]) {
      expect(tags.has(requiredTag), requiredTag).toBe(true);
    }
  });

  it("keeps the standard quote request at the approved medium value level", () => {
    const fixture = aiMemoryScenarioFixtures.find(
      (item) => item.fixture_id === "B-01-QUOTE-MISSING-CITY",
    )!;

    expect(fixture.expected_analysis.value_assessment.level).toBe("medium");
    expect(fixture.annotation.expected.value_level).toBe("medium");
  });

  it("covers confirmed, inferred and conflicted memory mutations", () => {
    const statuses = new Set(
      aiMemoryScenarioFixtures.flatMap((fixture) =>
        fixture.expected_memory_plan.fact_upserts.map((fact) => fact.status),
      ),
    );

    expect(statuses).toEqual(new Set(["confirmed", "inferred", "conflicted"]));
  });

  it("keeps every fixture entity and evidence source inside its conversation", () => {
    for (const fixture of aiMemoryScenarioFixtures) {
      expect(hasOnlySameConversationEntities(fixture), fixture.fixture_id).toBe(true);
    }
  });

  it("locks the expected stage annotation for each B-01 fixture", () => {
    for (const [fixtureId, expectedStage] of expectedStageRecommendations) {
      const fixture = aiMemoryScenarioFixtures.find((item) => item.fixture_id === fixtureId);

      expect(fixture, fixtureId).toBeDefined();
      expect(fixture?.expected_analysis.stage_recommendation, fixtureId).toBe(expectedStage);
    }
  });

  it("keeps annotation labels aligned with the contract outputs", () => {
    for (const fixture of aiMemoryScenarioFixtures) {
      const expected = fixture.annotation.expected;
      const analysis = fixture.expected_analysis;
      const plan = fixture.expected_memory_plan;

      expect(analysis.intent, fixture.fixture_id).toBe(expected.intent);
      expect(analysis.value_assessment.level, fixture.fixture_id).toBe(expected.value_level);
      expect(analysis.recommended_next_action, fixture.fixture_id).toBe(expected.next_action);
      expect(analysis.slot_updates.map((update) => update.slot), fixture.fixture_id).toEqual(
        expected.slot_updates,
      );
      expect(analysis.missing_fields.map((field) => field.slot), fixture.fixture_id).toEqual(
        expected.missing_fields,
      );
      expect(analysis.safety_flags.map((flag) => flag.code), fixture.fixture_id).toEqual(
        expected.safety_codes,
      );
      expect(plan.fact_upserts.map((fact) => fact.fact_key), fixture.fixture_id).toEqual(
        expected.fact_upserts,
      );
    }
  });

  it("records traceable evidence and explicit unacceptable outputs", () => {
    for (const fixture of aiMemoryScenarioFixtures) {
      const availableEvidence = collectEvidenceSourceIds(fixture);
      for (const sourceId of fixture.annotation.required_evidence_source_ids) {
        expect(availableEvidence.has(sourceId), `${fixture.fixture_id}:${sourceId}`).toBe(true);
      }
      expect(fixture.annotation.unacceptable_outputs.length, fixture.fixture_id).toBeGreaterThan(0);
      expect(fixture.annotation.contains_real_pii, fixture.fixture_id).toBe(false);
    }
  });

  it("contains no phone numbers, email addresses or credential-shaped values", () => {
    const serialized = JSON.stringify(aiMemoryScenarioFixtures);
    expect(serialized).not.toMatch(/1[3-9]\d{9}/);
    expect(serialized).not.toMatch(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    expect(serialized).not.toMatch(/(?:api[_-]?key|access[_-]?key|secret)\s*[:=]\s*["'][^"']+/i);
    expect(serialized).not.toMatch(/\b\d{17}[\dX]\b/i);
    expect(serialized).not.toMatch(/\b\d{16,19}\b/);
    expect(serialized).not.toMatch(/\b(?:sk|gh[pousr])_[A-Z0-9_]{20,}\b/i);
  });

  it("rejects invalid cross-conversation, evidence and summary examples", () => {
    expect(
      AnalysisRequestSchema.safeParse(
        invalidAiMemoryFixtures.analysisRequestWithMismatchedConversation,
      ).success,
    ).toBe(false);
    expect(
      MemoryMutationPlanSchema.safeParse(invalidAiMemoryFixtures.confirmedFactWithoutEvidence)
        .success,
    ).toBe(false);
    expect(
      MemoryMutationPlanSchema.safeParse(
        invalidAiMemoryFixtures.memoryPlanWithForeignConversationEvidence,
      ).success,
    ).toBe(true);
    const quoteFixture = aiMemoryScenarioFixtures.find(
      (fixture) => fixture.fixture_id === "B-01-QUOTE-MISSING-CITY",
    )!;
    expect(
      hasOnlySameConversationEntities({
        ...quoteFixture,
        expected_memory_plan:
          invalidAiMemoryFixtures.memoryPlanWithForeignConversationEvidence,
      }),
    ).toBe(false);
    expect(ContextBundleSchema.safeParse(invalidAiMemoryFixtures.invalidSummaryRange).success).toBe(
      false,
    );
    expect(
      AnalysisResultSchema.safeParse(invalidAiMemoryFixtures.knownValueWithoutMessageEvidence)
        .success,
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  AnalysisRequestSchema,
  AnalysisResultSchema,
  ContextBundleSchema,
  MemoryMutationPlanSchema,
} from "../../packages/contracts/src";
import {
  aiMemoryScenarioFixtures,
  invalidAiMemoryFixtures,
} from "../../packages/test-fixtures/src";

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

  it("covers confirmed, inferred and conflicted memory mutations", () => {
    const statuses = new Set(
      aiMemoryScenarioFixtures.flatMap((fixture) =>
        fixture.expected_memory_plan.fact_upserts.map((fact) => fact.status),
      ),
    );

    expect(statuses).toEqual(new Set(["confirmed", "inferred", "conflicted"]));
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
    expect(ContextBundleSchema.safeParse(invalidAiMemoryFixtures.invalidSummaryRange).success).toBe(
      false,
    );
    expect(
      AnalysisResultSchema.safeParse(invalidAiMemoryFixtures.knownValueWithoutMessageEvidence)
        .success,
    ).toBe(false);
  });
});

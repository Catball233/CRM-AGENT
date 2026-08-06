import { describe, it, expect, beforeEach } from "vitest";
import {
  MemoryMutationPlanSchema,
  ContextBundleSchema,
  MemoryMutationPlan,
  FactKey,
  CustomerFact,
} from "@crm-agent/contracts";
import {
  aiMemoryScenarioFixtures,
  invalidAiMemoryFixtures,
  type AiMemoryScenarioFixture,
} from "@crm-agent/test-fixtures";
import { InMemoryRepository, MemoryService } from "../src";
import type { FactIdProvider } from "../src/in-memory-repository";

function createDeterministicFactIdProvider(
  fixture: AiMemoryScenarioFixture,
): FactIdProvider {
  // 建立 fact_key → expected fact_id 的查找表。若同一 fact_key 出现多次（冲突场景），
  // 按 status 再细分为冲突版本/旧版本，仍匹配不上时退回默认。
  const expected = fixture.expected_memory_plan as MemoryMutationPlan;
  const byKeyStatus = new Map<string, string>();
  for (const fact of expected.fact_upserts as CustomerFact[]) {
    const key = `${fact.fact_key}::${fact.status}`;
    if (!byKeyStatus.has(key)) byKeyStatus.set(key, fact.fact_id);
    if (!byKeyStatus.has(fact.fact_key)) byKeyStatus.set(fact.fact_key, fact.fact_id);
  }
  return (_conversationId, factKey, _src, status) => {
    const k1 = `${factKey}::${status}`;
    if (byKeyStatus.has(k1)) return byKeyStatus.get(k1)!;
    if (byKeyStatus.has(factKey)) return byKeyStatus.get(factKey)!;
    // 冲突场景的 fact_ids_to_mark_conflicted 中指向的旧 fact 也可能需要（通常是旧的，非 upsert）
    for (const fid of expected.fact_ids_to_mark_conflicted) {
      // 不用于 fact upsert 的 id 只在此兜底，不参与生成
      void fid;
    }
    return "00000000-0000-4000-8000-000000000000";
  };
}

/**
 * MemoryMutationPlan 的宽松比较（fact_id、category、status、fact_key、value、
 * source_refs.source_type/source_id、confidence、updated_at 都匹配）。
 * 不严格比较 source_refs.excerpt（fixture 可能省略），也不比较 JSON 顺序。
 */
function expectMemoryPlanMatches(
  actual: MemoryMutationPlan,
  expected: MemoryMutationPlan,
) {
  expect(actual.contract_version, "contract_version match").toBe(
    expected.contract_version,
  );
  expect(actual.conversation_id, "conversation_id match").toBe(
    expected.conversation_id,
  );
  expect(actual.turn_id, "turn_id match").toBe(expected.turn_id);
  expect(actual.fact_ids_to_mark_conflicted, "mark_conflicted order-insensitive").toEqual(
    expect.arrayContaining(expected.fact_ids_to_mark_conflicted),
  );
  expect(actual.fact_ids_to_mark_conflicted.length).toBe(
    expected.fact_ids_to_mark_conflicted.length,
  );
  expect(actual.summary_upsert, "summary_upsert").toEqual(expected.summary_upsert);
  expect(actual.fact_upserts.length, "fact_upserts length").toBe(
    expected.fact_upserts.length,
  );
  for (let i = 0; i < expected.fact_upserts.length; i++) {
    const e = expected.fact_upserts[i] as CustomerFact;
    // 按 fact_id 找对应的
    const a = actual.fact_upserts.find(
      (x) => (x as CustomerFact).fact_id === e.fact_id,
    ) as CustomerFact | undefined;
    expect(a, `fact_upsert[${i}] fact_id=${e.fact_id} must exist`).toBeDefined();
    if (!a) continue;
    expect(a.fact_key, `fact ${e.fact_id} fact_key`).toBe(e.fact_key);
    expect(a.category, `fact ${e.fact_id} category`).toBe(e.category);
    expect(a.status, `fact ${e.fact_id} status`).toBe(e.status);
    expect(a.value, `fact ${e.fact_id} value`).toEqual(e.value);
    expect(a.updated_at, `fact ${e.fact_id} updated_at`).toBe(e.updated_at);
    if (e.confidence === undefined) {
      expect(a.confidence, `fact ${e.fact_id} confidence omitted`).toBeUndefined();
    } else {
      expect(a.confidence, `fact ${e.fact_id} confidence`).toBe(e.confidence);
    }
    expect(a.source_refs.length, `fact ${e.fact_id} source_refs length`).toBe(
      e.source_refs.length,
    );
    for (let j = 0; j < e.source_refs.length; j++) {
      const er = e.source_refs[j]!;
      const ar = a.source_refs[j]!;
      expect(ar.source_type, `fact ${e.fact_id} ref ${j} source_type`).toBe(
        er.source_type,
      );
      expect(ar.source_id, `fact ${e.fact_id} ref ${j} source_id`).toBe(er.source_id);
      if (er.excerpt !== undefined) {
        expect(ar.excerpt, `fact ${e.fact_id} ref ${j} excerpt`).toBe(er.excerpt);
      }
    }
  }
}

function fixtureFactUpdatedAt(fx: AiMemoryScenarioFixture): string {
  const expected = fx.expected_memory_plan.fact_upserts[0];
  if (!expected) return shiftIso(fx.analysis_request.current_message.created_at, 2_000);
  return (expected as CustomerFact).updated_at;
}

function shiftIso(iso: string, millis: number): string {
  const d = new Date(iso);
  return new Date(d.getTime() + millis).toISOString();
}

describe("B-04: MemoryService 契约测试（7 个 B-01 fixture）", () => {
  describe.each(aiMemoryScenarioFixtures)(
    "$fixture_id - $title",
    (fx) => {
      let svc: MemoryService;
      let repo: InMemoryRepository;

      beforeEach(() => {
        repo = new InMemoryRepository();
        // 将 fixture 的 context 预种入 Repository，供 buildContextBundle 复现
        const ctx = fx.analysis_request.context;
        const facts: CustomerFact[] = [
          ...ctx.confirmed_facts,
          ...ctx.inferred_facts,
          ...ctx.conflicted_facts,
        ];
        repo.seedConversation(
          ctx.conversation_id,
          ctx.stage,
          ctx.recent_messages,
          facts.length ? facts : undefined,
          ctx.memory_summary ?? undefined,
          ctx.current_quote ?? undefined,
        );
        svc = new MemoryService(
          repo,
          createDeterministicFactIdProvider(fx),
        );
      });

      it("planMemoryMutation 输出匹配 expected_memory_plan，并通过 MemoryMutationPlanSchema", () => {
        const updatedAt = fixtureFactUpdatedAt(fx);
        const plan = svc.planMemoryMutation({
          request: fx.analysis_request as never,
          analysis: fx.expected_analysis as never,
          factUpdatedAt: updatedAt,
        });
        const parsed = MemoryMutationPlanSchema.safeParse(plan);
        expect(parsed.success, "MemoryMutationPlanSchema pass").toBe(true);
        if (!parsed.success) {
          // 打印错误，便于调试
          console.error(
            `${fx.fixture_id} schema parse error:`,
            JSON.stringify(parsed.error.issues, null, 2).slice(0, 1500),
          );
        }
        expectMemoryPlanMatches(plan, fx.expected_memory_plan as never);
      });

      it("buildContextBundle 可构建满足 ContextBundleSchema 的 context", async () => {
        const bundle = await svc.buildContextBundle(
          fx.analysis_request.conversation_id,
          fx.analysis_request.current_message as never,
          {
            recentMessagesLimit: 20,
            now: fx.analysis_request.context.built_at,
          },
        );
        expect(
          ContextBundleSchema.safeParse(bundle).success,
          "ContextBundleSchema pass",
        ).toBe(true);
        expect(bundle.stage, "stage match").toBe(
          fx.analysis_request.context.stage,
        );
        expect(bundle.conversation_id).toBe(
          fx.analysis_request.conversation_id,
        );
        expect(bundle.confirmed_facts.length).toBe(
          fx.analysis_request.context.confirmed_facts.length,
        );
        expect(bundle.inferred_facts.length).toBe(
          fx.analysis_request.context.inferred_facts.length,
        );
        expect(bundle.conflicted_facts.length).toBe(
          fx.analysis_request.context.conflicted_facts.length,
        );
        // recall 场景必须产生至少两个 recalled_items（summary + quote）
        if (fx.fixture_id.includes("LONG-TERM-RECALL")) {
          expect(bundle.recalled_items.length, "recall >= 2 items").toBeGreaterThanOrEqual(2);
          const types = new Set(
            bundle.recalled_items.map((r) => r.source_ref.source_type),
          );
          expect(types.has("memory_summary"), "summary recall").toBe(true);
          expect(types.has("quote"), "quote recall").toBe(true);
        }
      });
    },
  );
});

describe("B-04: S04 上下文追忆门禁（跨会话隔离 + 正确召回）", () => {
  it("buildContextBundle 必须只读取同 conversation 的记忆和报价，不跨会话", async () => {
    const repo = new InMemoryRepository();
    const convA = "a0000000-0000-4000-8000-000000000001";
    const convB = "b0000000-0000-4000-8000-000000000001";
    const msgA = {
      message_id: "a0000000-0000-4000-8000-000000000002",
      role: "user" as const,
      content: "全屋中档",
      sequence: 1,
      created_at: "2026-08-05T10:00:00Z",
    };
    const msgA2 = {
      message_id: "a0000000-0000-4000-8000-000000000003",
      role: "user" as const,
      content: "还是按上次中档方案来",
      sequence: 7,
      created_at: "2026-08-05T10:05:00Z",
    };
    const factA: CustomerFact = {
      fact_id: "a0000000-0000-4000-8000-000000000004",
      fact_key: "material_tier" as FactKey,
      category: "preference",
      value: "mid",
      status: "confirmed",
      source_refs: [
        { source_type: "message", source_id: msgA.message_id, excerpt: "中档" },
      ],
      updated_at: "2026-08-05T10:00:02Z",
    };
    const factB: CustomerFact = {
      fact_id: "b0000000-0000-4000-8000-000000000004",
      fact_key: "budget_max_fen" as FactKey,
      category: "requirement",
      value: 9_000_000,
      status: "confirmed",
      source_refs: [
        {
          source_type: "message",
          source_id: "b0000000-0000-4000-8000-000000000002",
          excerpt: "9万预算",
        },
      ],
      updated_at: "2026-08-05T10:00:02Z",
    };
    repo.seedConversation(
      convA,
      "QUOTING",
      [msgA, msgA2],
      [factA],
      {
        summary_id: "a0000000-0000-4000-8000-000000000005",
        version: 1,
        text: "客户已确认全屋中档方案",
        covers_sequence_from: 1,
        covers_sequence_to: 6,
        source_message_ids: [msgA.message_id],
        created_at: "2026-08-05T10:03:00Z",
      },
      {
        quote_id: "a0000000-0000-4000-8000-000000000006",
        quote_version: 1,
        estimated_total_fen: 11_520_000,
        material_tier: "mid",
        created_at: "2026-08-05T10:02:00Z",
      },
    );
    repo.seedConversation(convB, "QUALIFYING", [], [factB]);
    const svc = new MemoryService(repo);
    // 查询 convA
    const bundleA = await svc.buildContextBundle(convA, msgA2, {
      now: "2026-08-05T10:05:01Z",
    });
    expect(bundleA.confirmed_facts.map((f) => f.fact_id)).toEqual(
      expect.arrayContaining([factA.fact_id]),
    );
    expect(
      bundleA.confirmed_facts.some((f) => f.fact_id === factB.fact_id),
      "convA must not see convB facts",
    ).toBe(false);
    expect(bundleA.memory_summary?.summary_id).toBe(
      "a0000000-0000-4000-8000-000000000005",
    );
    expect(bundleA.current_quote?.quote_id).toBe(
      "a0000000-0000-4000-8000-000000000006",
    );
    const recallTypes = new Set(
      bundleA.recalled_items.map((r) => r.source_ref.source_type),
    );
    expect(recallTypes.has("memory_summary"), "convA recall summary").toBe(true);
    expect(recallTypes.has("quote"), "convA recall quote").toBe(true);
    // 查询 convB
    const bundleB = await svc.buildContextBundle(
      convB,
      {
        message_id: "b0000000-0000-4000-8000-000000000003",
        role: "user",
        content: "你好",
        sequence: 2,
        created_at: "2026-08-05T10:06:00Z",
      },
      { now: "2026-08-05T10:06:01Z" },
    );
    expect(bundleB.confirmed_facts.map((f) => f.fact_id)).toEqual([factB.fact_id]);
    expect(bundleB.current_quote, "convB must not see convA quote").toBeNull();
    expect(bundleB.memory_summary, "convB must not see convA summary").toBeNull();
  });
});

describe("B-04: S05 长期记忆门禁（推断不冒充确认 + 冲突必标记）", () => {
  it("status=inferred 事实写入时仍保留 inferred，不得升级为 confirmed", () => {
    // 复用 INFERRED-PREFERENCE fixture
    const fx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("INFERRED-MATERIAL-PREFERENCE"),
    )!;
    const repo = new InMemoryRepository();
    const svc = new MemoryService(
      repo,
      createDeterministicFactIdProvider(fx),
    );
    const plan = svc.planMemoryMutation({
      request: fx.analysis_request as never,
      analysis: fx.expected_analysis as never,
      factUpdatedAt: fixtureFactUpdatedAt(fx),
    });
    expect(plan.fact_upserts.length).toBeGreaterThan(0);
    for (const f of plan.fact_upserts as CustomerFact[]) {
      // 这个场景只能生成 inferred status 的 preference fact
      expect(f.status, "inferred-only fixture must remain inferred").toBe(
        "inferred",
      );
    }
  });

  it("BUDGET-CONFLICT 场景：旧 confirmed fact 必须在 mark_conflicted 中出现", () => {
    const fx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("BUDGET-CONFLICT"),
    )!;
    const repo = new InMemoryRepository();
    const svc = new MemoryService(
      repo,
      createDeterministicFactIdProvider(fx),
    );
    const plan = svc.planMemoryMutation({
      request: fx.analysis_request as never,
      analysis: fx.expected_analysis as never,
      factUpdatedAt: fixtureFactUpdatedAt(fx),
    });
    expect(
      plan.fact_ids_to_mark_conflicted,
      "old budget must be conflicted",
    ).toEqual(expect.arrayContaining([fx.analysis_request.context.confirmed_facts[0]!.fact_id]));
    const conflictedFact = (plan.fact_upserts as CustomerFact[]).find(
      (f) => f.fact_key === "budget_max_fen",
    );
    expect(conflictedFact?.status, "new budget fact must be conflicted").toBe(
      "conflicted",
    );
  });
});

describe("B-04: 安全门禁（risk / safety_flags 阻止写入长期记忆）", () => {
  it("PROMPT-INJECTION：risk intent + high severity safety_flags → fact_upserts 必须空", () => {
    const fx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("PROMPT-INJECTION"),
    )!;
    const repo = new InMemoryRepository();
    const svc = new MemoryService(
      repo,
      createDeterministicFactIdProvider(fx),
    );
    const plan = svc.planMemoryMutation({
      request: fx.analysis_request as never,
      analysis: fx.expected_analysis as never,
      factUpdatedAt: fixtureFactUpdatedAt(fx),
    });
    expect(plan.fact_upserts.length, "no fact upsert on injection").toBe(0);
    expect(plan.fact_ids_to_mark_conflicted.length, "no conflict mark on injection").toBe(0);
    expect(plan.summary_upsert, "no summary upsert on injection").toBeNull();
  });

  it("confirmedFactWithoutEvidence：Schema 级别校验拒绝 source_refs 空", () => {
    const r = MemoryMutationPlanSchema.safeParse(
      invalidAiMemoryFixtures.confirmedFactWithoutEvidence,
    );
    expect(r.success, "source_refs empty must fail schema").toBe(false);
  });

  it("memoryPlanWithForeignConversationEvidence：planMemoryMutation 自身不接受外来 evidence，但契约 Schema 不阻断（后续 applyMutationPlan 负责）", () => {
    // Schema 本身不做跨会话检查，只保证结构正确
    const r = MemoryMutationPlanSchema.safeParse(
      invalidAiMemoryFixtures.memoryPlanWithForeignConversationEvidence,
    );
    expect(r.success).toBe(true);
  });
});

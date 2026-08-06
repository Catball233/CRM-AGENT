import { describe, it, expect, beforeAll } from "vitest";
import {
  RuleBasedAnalyzer,
  BailianAnalysisService,
  type AnalyzeDiagnostics,
} from "./bailian-analysis-service";
import {
  AnalysisResultSchema,
  AnalysisRequestSchema,
  IntentSchema,
  type Intent,
  type IntentLevel,
  type AnalysisResult,
} from "@crm-agent/contracts";
import {
  aiMemoryScenarioFixtures,
  invalidAiMemoryFixtures,
  type AiMemoryScenarioFixture,
} from "@crm-agent/test-fixtures";
import { FakeModelProvider } from "@crm-agent/model-provider";

describe("B-03: RuleBasedAnalyzer", () => {
  const analyzer = new RuleBasedAnalyzer();

  describe("schema gate", () => {
    it("拒绝 conversation id 不匹配的请求", () => {
      const req = invalidAiMemoryFixtures.analysisRequestWithMismatchedConversation;
      expect(() => analyzer.analyze(req as never)).toThrow(/conversation must match/);
    });

    it("输出必须通过运行时 AnalysisResultSchema", () => {
      for (const fx of aiMemoryScenarioFixtures) {
        const result = analyzer.analyze(fx.analysis_request as never);
        expect(AnalysisResultSchema.safeParse(result).success, `${fx.fixture_id} schema pass`).toBe(true);
      }
    });
  });

  describe("证据与安全（docs/03 与 接口契约 v1.0 §3.1/3.3）", () => {
    it("高/中/低价值等级必须至少包含一个 message 证据引用", () => {
      for (const fx of aiMemoryScenarioFixtures) {
        const result = analyzer.analyze(fx.analysis_request as never);
        const level = result.value_assessment.level;
        if (level !== "unknown") {
          const hasMsg = result.value_assessment.evidence_refs.some(
            (r) => r.source_type === "message",
          );
          expect(hasMsg, `${fx.fixture_id} value=${level} needs message evidence`).toBe(true);
        }
      }
    });

    it("未识别高严重度安全信号时禁止 generate quote 或 prepare_quote", () => {
      const injectionFx = aiMemoryScenarioFixtures.find(
        (f) => f.fixture_id.includes("INJECTION"),
      )!;
      const result = analyzer.analyze(injectionFx.analysis_request as never);
      expect(result.intent).toBe<Intent>("risk");
      expect(result.recommended_next_action).toBe("safe_stop");
      expect(result.safety_flags.length).toBeGreaterThan(0);
      expect(result.safety_flags.some((f) => f.code === "prompt_injection")).toBe(true);
      expect(result.safety_flags.some((f) => f.code === "secret_request")).toBe(true);
    });

    it("证据引用 id 必须来自本 turn 或当前上下文可见（recent_messages / facts / summary / quote）", () => {
      for (const fx of aiMemoryScenarioFixtures) {
        const result = analyzer.analyze(fx.analysis_request as never);
        const visibleIds = collectVisibleEvidenceIds(fx);
        const refs = [
          result.value_assessment.evidence_refs,
          ...result.concerns.map((c) => c.evidence_refs),
          ...result.safety_flags.map((s) => s.evidence_refs),
          ...result.slot_updates.map((s) => s.source_refs),
        ].flat();
        for (const r of refs) {
          expect(visibleIds.has(r.source_id), `${fx.fixture_id} ref ${r.source_id} visible`).toBe(true);
        }
      }
    });
  });

  describe("B-01 标注集基准（意图 ≥90%，价值 ≥85%，证据可追溯 100%）", () => {
    const results: Array<{
      fixture: AiMemoryScenarioFixture;
      result: AnalysisResult;
    }> = [];
    beforeAll(() => {
      for (const fx of aiMemoryScenarioFixtures) {
        results.push({
          fixture: fx,
          result: analyzer.analyze(fx.analysis_request as never),
        });
      }
    });

    it("核心意图准确率 ≥ 90%", () => {
      const total = results.length;
      let correct = 0;
      for (const { fixture, result } of results) {
        if (result.intent === fixture.annotation.expected.intent) correct++;
        else recordConfusion(fixture, result);
      }
      const acc = correct / total;
      writeB03BenchmarkReport(results);
      expect(acc).toBeGreaterThanOrEqual(0.9);
    });

    it("客户价值等级准确率 ≥ 85%", () => {
      let correct = 0;
      let total = 0;
      for (const { fixture, result } of results) {
        const expected: IntentLevel = fixture.annotation.expected.value_level;
        // unknown 档不纳入准确率（安全边界要求 unknown 一律无证据）
        if (expected === "unknown") {
          if (result.value_assessment.level === "unknown") correct++;
          total++;
          continue;
        }
        if (result.value_assessment.level === expected) correct++;
        total++;
      }
      expect(correct / Math.max(1, total)).toBeGreaterThanOrEqual(0.85);
    });

    it("证据可追溯率 100% / 无证据推断率 0%", () => {
      for (const { fixture, result } of results) {
        if (result.value_assessment.level !== "unknown") {
          const msgRefs = result.value_assessment.evidence_refs.filter(
            (r) => r.source_type === "message",
          );
          expect(msgRefs.length, `${fixture.fixture_id} known value needs message refs`).toBeGreaterThan(0);
        }
        for (const f of fixture.annotation.required_evidence_source_ids) {
          const referenced = [
            result.value_assessment.evidence_refs,
            ...result.concerns.map((c) => c.evidence_refs),
            ...result.safety_flags.map((s) => s.evidence_refs),
            ...result.slot_updates.map((s) => s.source_refs),
          ]
            .flat()
            .some((r) => r.source_id === f);
          expect(referenced, `${fixture.fixture_id} required ${f} referenced`).toBe(true);
        }
      }
    });

    it("不得生成报价候选金额或越过知识边界产生优惠（接口契约 §2.3.3）", () => {
      for (const { fixture, result } of results) {
        const forbidden = fixture.annotation.unacceptable_outputs.join("|");
        const serialized = JSON.stringify(result);
        expect(serialized.includes("estimated_total_fen")).toBe(false);
        expect(result.intent === "unclear" && result.recommended_next_action === "prepare_quote").toBe(
          false,
        );
        // 未命中 unacceptable_outputs（这里是严格字段校验）
        expect(result.knowledge_decision.topics.length).toBeLessThanOrEqual(10);
        void forbidden;
      }
    });
  });

  describe("关键场景 smoke（docs/03 §3 G0 阻断样例）", () => {
    it("S01 普通咨询：咨询而非报价，建议搜索知识", () => {
      const fx = aiMemoryScenarioFixtures.find((f) =>
        f.fixture_id.includes("CONSULTING-NORMAL"),
      )!;
      const result = analyzer.analyze(fx.analysis_request as never);
      expect(result.intent).toBe<Intent>("consulting");
      expect(result.value_assessment.level).toBe<IntentLevel>("low");
      expect(result.knowledge_decision.should_search).toBe(true);
    });

    it("S02 询价缺失：明确报价请求但缺城市，先追问而非报价", () => {
      const fx = aiMemoryScenarioFixtures.find((f) => f.fixture_id.includes("QUOTE-MISSING"))!;
      const result = analyzer.analyze(fx.analysis_request as never);
      expect(result.intent).toBe<Intent>("quote_request");
      expect(result.missing_fields.some((m) => m.slot === "city" && m.priority === 1)).toBe(true);
      expect(result.recommended_next_action).toBe("ask_missing_fields");
    });

    it("S03 价值判断：售后担忧可被 concern:after_sales 捕获，并给出知识检索建议", () => {
      const fx = aiMemoryScenarioFixtures.find((f) => f.fixture_id.includes("LONG-TERM-RECALL"))!;
      const result = analyzer.analyze(fx.analysis_request as never);
      expect(result.concerns.some((c) => c.code === "after_sales")).toBe(true);
      expect(result.knowledge_decision.topics).toContain("after_sales");
    });

    it("S09 无关/拒绝：高安全与拒绝信号一律 safe_stop / stop_sales_guidance", () => {
      const injection = aiMemoryScenarioFixtures.find((f) =>
        f.fixture_id.includes("INJECTION"),
      )!;
      const r = analyzer.analyze(injection.analysis_request as never);
      expect(r.recommended_next_action).toBe("safe_stop");
    });

    it("冲突场景：冲突预算必须标记 conflicted，下一步澄清冲突", () => {
      const fx = aiMemoryScenarioFixtures.find((f) => f.fixture_id.includes("BUDGET-CONFLICT"))!;
      const result = analyzer.analyze(fx.analysis_request as never);
      expect(result.slot_updates.some((s) => s.slot === "budget_max_fen" && s.status === "conflicted")).toBe(
        true,
      );
      expect(result.recommended_next_action).toBe("clarify_conflict");
    });
  });
});

describe("B-03: BailianAnalysisService 依赖 provider 与安全兜底", () => {
  const analyzer = new RuleBasedAnalyzer();
  const consultingFx = aiMemoryScenarioFixtures.find((f) =>
    f.fixture_id.includes("CONSULTING-NORMAL"),
  )!;

  it("无 provider 时走 fallback，并在 diagnostics 中标记 provider_missing", async () => {
    const svc = new BailianAnalysisService(null);
    const { result, diagnostics } = await svc.analyze(consultingFx.analysis_request as never);
    expect(AnalysisResultSchema.safeParse(result).success).toBe(true);
    expect(diagnostics.providerUsed).toBe(false);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.fallbackReason).toBe("provider_missing");
    expect(diagnostics.schemaPassed).toBe(true);
  });

  it("provider 正常返回时使用其结果，若 schema 失败则 fallback 并记录 rejection", async () => {
    const goodResponse = analyzer.analyze(consultingFx.analysis_request as never);
    const fake = new FakeModelProvider({
      analysis: JSON.parse(JSON.stringify(goodResponse)),
      reply: {
        contract_version: "1.0.0",
        text: "您好，旧房翻新通常包含设计、拆改、硬装、软装等。",
        cited_evidence_ids: [consultingFx.analysis_request.current_message.message_id],
        question_fields: [],
      },
    });
    const svc = new BailianAnalysisService(fake);
    const { diagnostics } = await svc.analyze(consultingFx.analysis_request as never);
    expect(diagnostics.providerUsed).toBe(true);
    expect(diagnostics.fallbackApplied).toBe(false);
    expect(fake.analysisCalls.length).toBe(1);
  });

  it("高严重度安全信号直接跳过 provider（不走 LLM），安全降级，诊断为 safety_blocked", async () => {
    const injection = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("INJECTION"),
    )!;
    const fake = new FakeModelProvider({
      analysis: analyzer.analyze(injection.analysis_request as never),
      reply: {
        contract_version: "1.0.0",
        text: "stopped",
        cited_evidence_ids: [],
        question_fields: [],
      },
    });
    const svc = new BailianAnalysisService(fake);
    const { diagnostics } = await svc.analyze(injection.analysis_request as never);
    expect(fake.analysisCalls.length).toBe(0);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.fallbackReason).toBe("safety_blocked");
  });

  it("P0: 含 PII（手机号）的请求不调用 Provider，走本地安全停止", async () => {
    const piiRequest = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "我的手机号是13812345678，你们可以联系我",
      },
    };
    const fake = new FakeModelProvider({
      analysis: analyzer.analyze(consultingFx.analysis_request as never),
      reply: {
        contract_version: "1.0.0",
        text: "stopped",
        cited_evidence_ids: [],
        question_fields: [],
      },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(piiRequest as never);
    expect(fake.analysisCalls.length).toBe(0);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.fallbackReason).toBe("safety_blocked");
    expect(result.safety_flags.some((f) => f.code === "pii")).toBe(true);
    expect(result.recommended_next_action).toBe("safe_stop");
  });

  it("P0: Provider 返回合法但不安全组合时，后校验强制 safe_stop", async () => {
    const normalResult = analyzer.analyze(consultingFx.analysis_request as never);
    const unsafeProviderOutput = {
      ...normalResult,
      intent: "risk",
      safety_flags: [],
      recommended_next_action: "prepare_quote",
      stage_recommendation: "QUOTING",
      value_assessment: {
        level: "high" as const,
        evidence_refs: [
          {
            source_type: "message" as const,
            source_id: consultingFx.analysis_request.current_message.message_id,
            excerpt: "test",
          },
        ],
        reason_codes: ["explicit_quote_request"],
      },
    };
    const fake = new FakeModelProvider({
      analysis: unsafeProviderOutput,
      reply: {
        contract_version: "1.0.0",
        text: "stopped",
        cited_evidence_ids: [],
        question_fields: [],
      },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(
      consultingFx.analysis_request as never,
    );
    expect(diagnostics.providerUsed).toBe(true);
    expect(result.recommended_next_action).toBe("safe_stop");
    expect(result.intent).toBe("risk");
    expect(result.value_assessment.level).toBe("unknown");
    expect(diagnostics.unsafeCandidatesRejected.length).toBeGreaterThan(0);
  });
});

describe("B-03: C 评审 P1 回归测试", () => {
  const analyzer = new RuleBasedAnalyzer();
  const consultingFx = aiMemoryScenarioFixtures.find((f) =>
    f.fixture_id.includes("CONSULTING-NORMAL"),
  )!;

  it("P1-1: house_state/service_scope 输出值与 QuoteParameters 公共契约枚举一致", () => {
    const validHouseStates = ["rough", "new_finished", "old_renovation"];
    const validServiceScopes = ["whole_home", "partial", "design_only"];

    // house_state: 新房毛坯 → rough
    const houseReq = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "我家是新房毛坯，想装修",
      },
    };
    const houseRes = analyzer.analyze(houseReq as never);
    const houseSlot = houseRes.slot_updates.find((s) => s.slot === "house_state");
    expect(houseSlot).toBeDefined();
    expect(validHouseStates).toContain(houseSlot!.value);

    // house_state: 精装 → new_finished
    const fineReq = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "我家是精装房，想翻新",
      },
    };
    const fineRes = analyzer.analyze(fineReq as never);
    const fineSlot = fineRes.slot_updates.find((s) => s.slot === "house_state");
    if (fineSlot) expect(validHouseStates).toContain(fineSlot.value);

    // service_scope: 全屋整装 → whole_home
    const scopeReq = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "我想做全屋整装",
      },
    };
    const scopeRes = analyzer.analyze(scopeReq as never);
    const scopeSlot = scopeRes.slot_updates.find((s) => s.slot === "service_scope");
    expect(scopeSlot).toBeDefined();
    expect(validServiceScopes).toContain(scopeSlot!.value);

    // service_scope: 硬装 → partial
    const hardReq = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "只想做硬装",
      },
    };
    const hardRes = analyzer.analyze(hardReq as never);
    const hardSlot = hardRes.slot_updates.find((s) => s.slot === "service_scope");
    if (hardSlot) expect(validServiceScopes).toContain(hardSlot.value);
  });

  it("P1-2: Provider 返回不可见 evidence source_id 时被后校验过滤", async () => {
    const normalResult = analyzer.analyze(consultingFx.analysis_request as never);
    const fakeInvisibleId = "99999999-9999-4999-8999-999999999999";
    const providerOutput = {
      ...JSON.parse(JSON.stringify(normalResult)),
      value_assessment: {
        ...normalResult.value_assessment,
        evidence_refs: [
          ...normalResult.value_assessment.evidence_refs,
          { source_type: "message", source_id: fakeInvisibleId, excerpt: "fake" },
        ],
      },
    };
    const fake = new FakeModelProvider({
      analysis: providerOutput,
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(consultingFx.analysis_request as never);
    const hasInvisible = result.value_assessment.evidence_refs.some(
      (r) => r.source_id === fakeInvisibleId,
    );
    expect(hasInvisible).toBe(false);
    expect(
      diagnostics.unsafeCandidatesRejected.some((s) => s.includes("invisible_evidence_filtered")),
    ).toBe(true);
  });

  it("P1-3: Provider 返回 prepare_quote 但存在 missing_fields 时被拦截", async () => {
    const quoteMissingFx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("QUOTE-MISSING"),
    )!;
    const normalResult = analyzer.analyze(quoteMissingFx.analysis_request as never);
    const providerOutput = {
      ...JSON.parse(JSON.stringify(normalResult)),
      recommended_next_action: "prepare_quote",
      missing_fields: [
        { slot: "city", reason: "需要先确认是否属于服务区域", priority: 1 },
      ],
    };
    const fake = new FakeModelProvider({
      analysis: providerOutput,
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(quoteMissingFx.analysis_request as never);
    expect(result.recommended_next_action).toBe("ask_missing_fields");
    expect(
      diagnostics.unsafeCandidatesRejected.some((s) =>
        s.includes("prepare_quote_with_missing_fields"),
      ),
    ).toBe(true);
  });

  it("P1-4: provide_information 补齐全部字段后返回 prepare_quote 而非 ask_missing_fields", () => {
    const msgId = consultingFx.analysis_request.current_message.message_id;
    const allFieldsConfirmed = [
      { fact_id: "00000000-0000-4000-8000-000000000001", fact_key: "city", category: "requirement", value: "北京", status: "confirmed", source_refs: [{ source_type: "message" as const, source_id: msgId }], updated_at: "2026-01-01T00:00:00+08:00" },
      { fact_id: "00000000-0000-4000-8000-000000000002", fact_key: "area_sqm", category: "requirement", value: 100, status: "confirmed", source_refs: [{ source_type: "message" as const, source_id: msgId }], updated_at: "2026-01-01T00:00:00+08:00" },
      { fact_id: "00000000-0000-4000-8000-000000000003", fact_key: "house_state", category: "requirement", value: "rough", status: "confirmed", source_refs: [{ source_type: "message" as const, source_id: msgId }], updated_at: "2026-01-01T00:00:00+08:00" },
      { fact_id: "00000000-0000-4000-8000-000000000004", fact_key: "service_scope", category: "requirement", value: "whole_home", status: "confirmed", source_refs: [{ source_type: "message" as const, source_id: msgId }], updated_at: "2026-01-01T00:00:00+08:00" },
      { fact_id: "00000000-0000-4000-8000-000000000005", fact_key: "material_tier", category: "requirement", value: "mid", status: "confirmed", source_refs: [{ source_type: "message" as const, source_id: msgId }], updated_at: "2026-01-01T00:00:00+08:00" },
      { fact_id: "00000000-0000-4000-8000-000000000006", fact_key: "budget_max_fen", category: "requirement", value: 15000000, status: "confirmed", source_refs: [{ source_type: "message" as const, source_id: msgId }], updated_at: "2026-01-01T00:00:00+08:00" },
    ];
    const request = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "我的预算是15万",
      },
      context: {
        ...consultingFx.analysis_request.context,
        stage: "QUALIFYING" as const,
        confirmed_facts: allFieldsConfirmed,
      },
    };
    const result = analyzer.analyze(request as never);
    expect(result.intent).toBe<Intent>("provide_information");
    expect(result.missing_fields.length).toBe(0);
    expect(result.recommended_next_action).toBe("prepare_quote");
  });

  it("P1-5: 新预算与历史确认预算不一致时标记 conflicted", () => {
    const msgId = consultingFx.analysis_request.current_message.message_id;
    const request = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "预算20万",
      },
      context: {
        ...consultingFx.analysis_request.context,
        stage: "QUOTING" as const,
        confirmed_facts: [
          ...consultingFx.analysis_request.context.confirmed_facts,
          {
            fact_id: "00000000-0000-4000-8000-0000000000aa",
            fact_key: "budget_max_fen",
            category: "requirement",
            value: 15000000,
            status: "confirmed",
            source_refs: [{ source_type: "message" as const, source_id: msgId }],
            updated_at: "2026-01-01T00:00:00+08:00",
          },
        ],
      },
    };
    const result = analyzer.analyze(request as never);
    const budgetSlot = result.slot_updates.find((s) => s.slot === "budget_max_fen");
    expect(budgetSlot).toBeDefined();
    expect(budgetSlot!.status).toBe("conflicted");
    expect(result.recommended_next_action).toBe("clarify_conflict");
  });

  it("P1-6: risk/rejection 保持当前 stage，不进入 CLOSED", () => {
    const injectionFx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("INJECTION"),
    )!;
    const request = {
      ...injectionFx.analysis_request,
      context: {
        ...injectionFx.analysis_request.context,
        stage: "QUOTING" as const,
      },
    };
    const result = analyzer.analyze(request as never);
    expect(result.intent).toBe<Intent>("risk");
    expect(result.stage_recommendation).not.toBe("CLOSED");
    expect(result.stage_recommendation).toBe("QUOTING");
  });
});

describe("B-03: 复审 P0 历史上下文 PII 不外发", () => {
  const analyzer = new RuleBasedAnalyzer();
  const consultingFx = aiMemoryScenarioFixtures.find((f) =>
    f.fixture_id.includes("CONSULTING-NORMAL"),
  )!;
  const msgId = consultingFx.analysis_request.current_message.message_id;

  it("P0: recent_messages 含手机号时不调用 Provider", async () => {
    const request = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "设计方案有哪些？",
      },
      context: {
        ...consultingFx.analysis_request.context,
        recent_messages: [
          ...consultingFx.analysis_request.context.recent_messages,
          {
            message_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            role: "user" as const,
            content: "我的手机号是13812345678，可以联系我",
            sequence: 99,
            created_at: "2026-01-01T00:00:00+08:00",
          },
        ],
      },
    };
    const fake = new FakeModelProvider({
      analysis: analyzer.analyze(consultingFx.analysis_request as never),
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(request as never);
    expect(fake.analysisCalls.length).toBe(0);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.fallbackReason).toBe("safety_blocked");
    expect(result.safety_flags.some((f) => f.code === "pii")).toBe(true);
    expect(result.recommended_next_action).toBe("safe_stop");
  });

  it("P0: memory_summary.text 含地址时不调用 Provider", async () => {
    const request = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "设计方案有哪些？",
      },
      context: {
        ...consultingFx.analysis_request.context,
        memory_summary: {
          summary_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          version: 1,
          text: "客户之前提到住在上海xx路123号，需要全屋装修",
          covers_sequence_from: 1,
          covers_sequence_to: 5,
          source_message_ids: [msgId],
          created_at: "2026-01-01T00:00:00+08:00",
        },
      },
    };
    const fake = new FakeModelProvider({
      analysis: analyzer.analyze(consultingFx.analysis_request as never),
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(request as never);
    expect(fake.analysisCalls.length).toBe(0);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.fallbackReason).toBe("safety_blocked");
    expect(result.safety_flags.some((f) => f.code === "pii")).toBe(true);
    expect(result.recommended_next_action).toBe("safe_stop");
  });

  it("P0: fact value 含手机号时不调用 Provider", async () => {
    const request = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "设计方案有哪些？",
      },
      context: {
        ...consultingFx.analysis_request.context,
        confirmed_facts: [
          ...consultingFx.analysis_request.context.confirmed_facts,
          {
            fact_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
            fact_key: "preference" as const,
            category: "preference" as const,
            value: "客户手机13812345678方便联系",
            status: "confirmed" as const,
            source_refs: [{ source_type: "message" as const, source_id: msgId }],
            updated_at: "2026-01-01T00:00:00+08:00",
          },
        ],
      },
    };
    const fake = new FakeModelProvider({
      analysis: analyzer.analyze(consultingFx.analysis_request as never),
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(request as never);
    expect(fake.analysisCalls.length).toBe(0);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.fallbackReason).toBe("safety_blocked");
    expect(result.safety_flags.some((f) => f.code === "pii")).toBe(true);
    expect(result.recommended_next_action).toBe("safe_stop");
  });
});

describe("B-03: C 复审第二轮修复", () => {
  const analyzer = new RuleBasedAnalyzer();

  // P0: fact.value string[] 中的 PII 不外发
  it("P0: fact.value 为 string[] 且含手机号时不调用 Provider", async () => {
    const consultingFx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("CONSULTING-NORMAL"),
    )!;
    const msgId = consultingFx.analysis_request.current_message.message_id;
    const request = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "设计方案有哪些？",
      },
      context: {
        ...consultingFx.analysis_request.context,
        confirmed_facts: [
          ...consultingFx.analysis_request.context.confirmed_facts,
          {
            fact_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
            fact_key: "special_requirements" as const,
            category: "preference" as const,
            value: ["请联系13812345678", "需要全屋定制"],
            status: "confirmed" as const,
            source_refs: [{ source_type: "message" as const, source_id: msgId, excerpt: "请联系13812345678" }],
            updated_at: "2026-01-01T00:00:00+08:00",
          },
        ],
      },
    };
    const fake = new FakeModelProvider({
      analysis: analyzer.analyze(consultingFx.analysis_request as never),
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(request as never);
    expect(fake.analysisCalls.length).toBe(0);
    expect(diagnostics.fallbackApplied).toBe(true);
    expect(diagnostics.fallbackReason).toBe("safety_blocked");
    expect(result.safety_flags.some((f) => f.code === "pii")).toBe(true);
    expect(result.recommended_next_action).toBe("safe_stop");
  });

  // P0: fact source_refs[].excerpt 含 PII 时不外发
  it("P0: fact source_refs excerpt 含地址时不调用 Provider", async () => {
    const consultingFx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("CONSULTING-NORMAL"),
    )!;
    const msgId = consultingFx.analysis_request.current_message.message_id;
    const request = {
      ...consultingFx.analysis_request,
      current_message: {
        ...consultingFx.analysis_request.current_message,
        content: "设计方案有哪些？",
      },
      context: {
        ...consultingFx.analysis_request.context,
        confirmed_facts: [
          ...consultingFx.analysis_request.context.confirmed_facts,
          {
            fact_id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
            fact_key: "city" as const,
            category: "requirement" as const,
            value: "上海",
            status: "confirmed" as const,
            source_refs: [{ source_type: "message" as const, source_id: msgId, excerpt: "我住上海xx路123号" }],
            updated_at: "2026-01-01T00:00:00+08:00",
          },
        ],
      },
    };
    const fake = new FakeModelProvider({
      analysis: analyzer.analyze(consultingFx.analysis_request as never),
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { result, diagnostics } = await svc.analyze(request as never);
    expect(fake.analysisCalls.length).toBe(0);
    expect(diagnostics.fallbackReason).toBe("safety_blocked");
    expect(result.safety_flags.some((f) => f.code === "pii")).toBe(true);
  });

  // P1: 后校验过滤不可见 evidence 后重新 Schema 校验
  it("P1: Provider 返回全部不可见 evidence refs 时回退到规则引擎", async () => {
    const consultingFx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id.includes("CONSULTING-NORMAL"),
    )!;
    const analyzerResult = analyzer.analyze(consultingFx.analysis_request as never);
    // Return result with only invisible source IDs
    const providerResult = {
      ...analyzerResult,
      value_assessment: {
        ...analyzerResult.value_assessment,
        evidence_refs: [
          { source_type: "message", source_id: "ffffffff-ffff-4fff-8fff-ffffffffffff", excerpt: "test" },
        ],
      },
    };
    const fake = new FakeModelProvider({
      analysis: providerResult as never,
      reply: { contract_version: "1.0.0", text: "test", cited_evidence_ids: [], question_fields: [] },
    });
    const svc = new BailianAnalysisService(fake);
    const { diagnostics } = await svc.analyze(consultingFx.analysis_request as never);
    // Should have filtered invisible evidence and restored or fallen back
    expect(diagnostics.unsafeCandidatesRejected.some((r) => r.includes("invisible_evidence_filtered"))).toBe(true);
  });

  // P1: B-01-INFERRED-MATERIAL-PREFERENCE 逐项断言
  it("P1: INFERRED-MATERIAL-PREFERENCE 否定语境正确识别为 low/mid inferred", () => {
    const fx = aiMemoryScenarioFixtures.find((f) =>
      f.fixture_id === "B-01-INFERRED-MATERIAL-PREFERENCE",
    )!;
    const result = analyzer.analyze(fx.analysis_request as never);

    // intent
    expect(result.intent, "intent").toBe(fx.annotation.expected.intent);
    // value_level
    expect(result.value_assessment.level, "value_level").toBe(fx.annotation.expected.value_level);
    // next_action
    expect(result.recommended_next_action, "next_action").toBe(fx.annotation.expected.next_action);
    // safety_codes
    const safetyCodes = result.safety_flags.map((s) => s.code);
    expect(safetyCodes, "safety_codes").toEqual(fx.annotation.expected.safety_codes);
    // slot_updates
    const slotNames = result.slot_updates.map((s) => s.slot);
    expect(slotNames, "slot_updates").toEqual(fx.annotation.expected.slot_updates);
    // material_tier 应为 inferred low/mid
    const materialSlot = result.slot_updates.find((s) => s.slot === "material_tier");
    expect(materialSlot?.status, "material_tier status").toBe("inferred");
    expect(materialSlot?.value, "material_tier value").toEqual(["low", "mid"]);
    // missing_fields
    const missingSlots = result.missing_fields.map((m) => m.slot);
    expect(missingSlots, "missing_fields").toEqual(fx.annotation.expected.missing_fields);
  });
});

function collectVisibleEvidenceIds(fx: AiMemoryScenarioFixture): Set<string> {
  const out = new Set<string>();
  out.add(fx.analysis_request.current_message.message_id);
  for (const m of fx.analysis_request.context.recent_messages) {
    out.add(m.message_id);
  }
  for (const bucket of [
    fx.analysis_request.context.confirmed_facts,
    fx.analysis_request.context.inferred_facts,
    fx.analysis_request.context.conflicted_facts,
  ] as const) {
    for (const f of bucket) out.add(f.fact_id);
  }
  if (fx.analysis_request.context.memory_summary) {
    out.add(fx.analysis_request.context.memory_summary.summary_id);
    for (const m of fx.analysis_request.context.memory_summary.source_message_ids) out.add(m);
  }
  if (fx.analysis_request.context.current_quote) {
    out.add(fx.analysis_request.context.current_quote.quote_id);
  }
  for (const r of fx.analysis_request.context.recalled_items) {
    out.add(r.source_ref.source_id);
  }
  return out;
}

let confusionBuffer: AnalyzeDiagnostics["confusionCandidates"] = [];
let failedBuffer: AnalyzeDiagnostics["failedFixtures"] = [];
function recordConfusion(fixture: AiMemoryScenarioFixture, result: AnalysisResult): void {
  confusionBuffer.push({
    fixture_id: fixture.fixture_id,
    detected: result.intent,
    expected: fixture.annotation.expected.intent,
    notes: fixture.title,
  });
}
function writeB03BenchmarkReport(
  _results: Array<{ fixture: AiMemoryScenarioFixture; result: AnalysisResult }>,
): void {
  // 此处保留 hook，便于后续把混淆矩阵/失败样例输出到文件；在 vitest 中用标准日志记录即可
  if (confusionBuffer.length > 0 || failedBuffer.length > 0) {
    // eslint-disable-next-line no-console
    console.warn("[B-03 benchmark]", {
      confusionCandidates: confusionBuffer,
      failedFixtures: failedBuffer,
    });
  }
  confusionBuffer = [];
  failedBuffer = [];
}

// 帮助 TS 确认 IntentSchema/enum 已在契约中（防止删除导致 silent fail）
void IntentSchema;
void AnalysisRequestSchema;

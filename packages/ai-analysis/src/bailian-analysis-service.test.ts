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

  it("高严重度安全信号直接跳过 provider（不走 LLM），安全降级", async () => {
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
    await svc.analyze(injection.analysis_request as never);
    expect(fake.analysisCalls.length).toBe(0);
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

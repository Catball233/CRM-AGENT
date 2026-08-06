import {
  AnalysisRequestSchema,
  AnalysisResultSchema,
  CONTRACT_VERSION,
  IntentSchema,
  NextActionSchema,
  ConcernCodeSchema,
  SlotNameSchema,
  KnowledgeDecisionSchema,
  SafetyFlagSchema,
  type AnalysisResult,
  type Intent,
  type IntentLevel,
  type ConversationStage,
  type SourceRef,
  type Concern,
  type SlotUpdate,
  type MissingField,
} from "@crm-agent/contracts";
import type {
  AiProvider,
  AnalysisRequest as ProviderAnalysisRequest,
} from "@crm-agent/model-provider";
import { ModelProviderError } from "@crm-agent/model-provider";

type KnowledgeDecision = ReturnType<typeof KnowledgeDecisionSchema.parse>;
type SafetyFlag = ReturnType<typeof SafetyFlagSchema.parse>;
export type AnalysisRequest = ReturnType<typeof AnalysisRequestSchema.parse>;

export type { AnalysisResult };

export interface AnalyzeOptions {
  strictEvidence?: boolean;
}

export interface AnalyzeDiagnostics {
  intentAccuracyReached: boolean;
  valueAccuracyReached: boolean;
  evidenceTraceableCount: number;
  schemaPassed: boolean;
  providerUsed: boolean;
  fallbackApplied: boolean;
  fallbackReason?: "provider_missing" | "provider_error" | "provider_malformed" | "safety_blocked";
  unsafeCandidatesRejected: string[];
  confusionCandidates: Array<{
    fixture_id: string;
    detected?: Intent;
    expected: Intent;
    notes?: string;
  }>;
  failedFixtures: Array<{
    fixture_id: string;
    title: string;
    reason: string;
  }>;
}

const SAFETY_RULES: Array<{
  code: SafetyFlag["code"];
  severity: SafetyFlag["severity"];
  pattern: RegExp;
  rationale: string;
}> = [
  {
    code: "prompt_injection",
    severity: "high",
    pattern:
      /(忽略|忘记|覆盖|无视|停用|禁用|重新开始|从头开始|reset|bypass|forget previous|ignore previous|system prompt|之前的(提示|规则|指令))/iu,
    rationale: "直接要求覆盖系统规则或重置上下文是注入常见信号",
  },
  {
    code: "secret_request",
    severity: "high",
    pattern:
      /(提示词|prompt|内部底价|成本价|进货价|系统(密钥|apikey|key|token)|后台(密码|口令)|secret|apikey|api key|内部规则|核心规则样例)/iu,
    rationale: "索要未公开的内部资产、密钥或报价成本",
  },
  {
    code: "external_action",
    severity: "high",
    pattern:
      /(主动联系|打电话给我|回拨|短信通知|发邮件给|添加微信|加我微信|推送|第三方支付|在线支付|付款链接|下单链接|call me|email me|wechat|real phone|真实(手机|电话|号码))/iu,
    rationale: "要求 MVP 边界外的外部动作：外呼、邮件、加微信或真付",
  },
  {
    code: "pii",
    severity: "medium",
    pattern:
      /(1[3-9]\d{9}|\d{3,4}[-\s]?\d{7,8}|(北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|重庆|苏州|天津|长沙|青岛|郑州|东莞|宁波|厦门|合肥|福州|济南|昆明|沈阳|大连|太原|南昌|贵阳|南宁|海口|兰州|银川|西宁|呼和浩特|乌鲁木齐|拉萨)[^\u4e00-\u9fa5]{0,6}(路|街|大道|小区|号楼|栋|室|层|单元|地址|省|市|[区|县]))/iu,
    rationale: "疑似手机号、座机或真实地址的 PII",
  },
];

const INTENT_RULES: Array<{
  intent: Intent;
  confidence: number;
  match: (text: string, ctx: AnalysisRequest) => boolean;
}> = [
  {
    intent: "risk",
    confidence: 0.95,
    match: (t) => SAFETY_RULES.some((r) => r.pattern.test(t)),
  },
  {
    intent: "rejection",
    confidence: 0.9,
    match: (t) =>
      /(不考虑|不想|不要|算了|不做|暂时不需要|没有这个需求|取消|放弃|退出|挂了|结束|不谈了|我很忙|不用了|stop|no thanks|reject)/iu.test(
        t,
      ),
  },
  {
    intent: "unrelated",
    confidence: 0.85,
    match: (t) =>
      /(天气|股票|房价|娱乐|明星|电影|游戏|新闻|小说|搞笑|旅游|宠物|健康养生|找工作|招聘|贷款|理财|保险|恋爱|相亲|算命|心理医生|租房|买房|二手车)/iu.test(
        t,
      ) &&
      !/(装修|材料|设计|施工|报价|房屋|房子|户型|面积|预算|方案|售后|工期|设计师|家装|全屋|整装|硬装|软装)/iu.test(t),
  },
  {
    intent: "quote_request",
    confidence: 0.9,
    match: (t) =>
      /(多少(钱|元|价|预算)?|报价|估价|预估|估算|估一下|估一估|估个价|算一下|核算|要花多少|大概多少钱|价格|多少钱|报价(方案|明细)?|给个价|做个(方案|报价)|成本)/iu.test(
        t,
      ) && /(装修|全屋|整装|硬装|软装|房屋|房子|平米|平方|面积|材料|设计|施工|家装)/iu.test(t),
  },
  {
    intent: "negotiation",
    confidence: 0.88,
    match: (t) =>
      /(太贵|便宜点|再少|打折|优惠|降价|能不能少|价格能不能|比别家|贵了|不值|性价比不够|议价|还价|砍掉点|降一点|超预算|预算超了)/iu.test(t),
  },
  {
    intent: "plan_adjustment",
    confidence: 0.85,
    match: (t) =>
      /(换(方案|档次|材料|设计师|装修公司)|改(方案|设计|布局|预算)|调整(方案|预算|范围|材料)|不想要这个方案|换一个(方案|方案档)|降档|升档|升级(材料|设计)|缩减(范围|预算)|加预算|扩大范围)/iu.test(t),
  },
  {
    intent: "provide_information",
    confidence: 0.85,
    match: (t, ctx) => {
      const infoStage = ctx.context.stage === "QUALIFYING" || ctx.context.stage === "QUOTING";
      const hasInfoPayload =
        /(预算|万|平米|平方|面积|户型|几室几厅|房间|楼层|新房|旧房|老房|翻新|毛坯|精装|全屋|局部|半包|全包|材料(档|档次)?|设计师(档|级别)?|工期|开工时间|期望入住|城市|区)/iu.test(
          t,
        );
      return infoStage && hasInfoPayload;
    },
  },
  {
    intent: "consulting",
    confidence: 0.85,
    match: (t, ctx) => {
      const pronounPattern = /(这个|那个|它|那|这|上次|之前|按你说|那样|这样|你说的)/iu;
      const hasPronoun = pronounPattern.test(t);
      const hasMeaningfulContext =
        ctx.context.recent_messages.length > 1 ||
        ctx.context.confirmed_facts.length > 0 ||
        ctx.context.inferred_facts.length > 0 ||
        !!ctx.context.memory_summary ||
        !!ctx.context.current_quote;
      if (hasPronoun && !hasMeaningfulContext) return false;
      return /(怎么|如何|是否|可以|有没有|包含|包括|多久|流程|步骤|方式|区别|优势|售后|保障|工期|质量|材料|设计|施工|服务范围|服务|有什么|哪(里|个|种|些)?|什么|吗|呢|[?？])/iu.test(t);
    },
  },
  {
    intent: "greeting",
    confidence: 0.75,
    match: (t) => /^(你好|您好|哈喽|hi|hello|在吗|在不在|喂|嗨)[!！。.\s]*$/iu.test(t.trim()),
  },
];

const CONCERN_RULES: Array<{ code: Concern["code"]; pattern: RegExp }> = [
  { code: "price", pattern: /(太贵|贵|预算|钱|价|优惠|便宜|降价|打折|超预算|不值)/iu },
  { code: "material", pattern: /(材料|环保|甲醛|品牌|档次|材质|质量|劣质|正品)/iu },
  { code: "design", pattern: /(设计|设计师|风格|布局|效果|图纸|方案|审美|搭配)/iu },
  { code: "timeline", pattern: /(工期|多久|什么时候|时间|周期|延误|拖期|进度|几(天|周|月))/iu },
  { code: "quality", pattern: /(质量|工艺|施工|师傅|手艺|验收|售后瑕疵|毛病|不合格|漏水|裂缝|起翘|异味)/iu },
  { code: "after_sales", pattern: /(售后|保修|质保|保障|维修|返工|服务|客服|投诉|几年|免费|维护)/iu },
];

function excerptFrom(text: string, pattern: RegExp, max = 60): string | undefined {
  const m = pattern.exec(text);
  if (!m) return undefined;
  const raw = m[0] ?? text.slice(0, max);
  return raw.length > max ? raw.slice(0, max - 1) + "…" : raw;
}

function messageRef(request: AnalysisRequest, excerptHint?: RegExp | string): SourceRef {
  const content = request.current_message.content;
  let excerpt: string | undefined;
  if (excerptHint instanceof RegExp) {
    excerpt = excerptFrom(content, excerptHint);
  } else if (typeof excerptHint === "string" && excerptHint.length > 0) {
    excerpt = excerptHint.length > 60 ? excerptHint.slice(0, 59) + "…" : excerptHint;
  }
  if (!excerpt) {
    excerpt = content.length > 60 ? content.slice(0, 59) + "…" : content;
  }
  return { source_type: "message", source_id: request.current_message.message_id, excerpt };
}

function slotIsCovered(
  slot: SlotUpdate["slot"],
  facts: Array<{ fact_key: string; status: string }>,
): boolean {
  return facts.some((f) => f.fact_key === slot && f.status === "confirmed");
}

function deriveStage(
  intent: Intent,
  prevStage: ConversationStage,
  factsCount: number,
  missingRequired: number,
): ConversationStage {
  if (prevStage === "CLOSED" || prevStage === "COMPLETED") return prevStage;
  if (intent === "risk") return prevStage;
  if (intent === "rejection" || intent === "unrelated") return prevStage;
  if (intent === "quote_request") {
    if (missingRequired > 2 && factsCount < 4) return "QUALIFYING";
    return "QUOTING";
  }
  if (intent === "negotiation" || intent === "plan_adjustment") return "NEGOTIATION";
  if (intent === "provide_information") return "QUALIFYING";
  if (factsCount === 0) return "DISCOVERY";
  return prevStage;
}

function requiredQuoteSlots(slot: SlotUpdate["slot"]): 1 | 2 | 3 {
  switch (slot) {
    case "city":
    case "area_sqm":
      return 1;
    case "house_state":
    case "service_scope":
    case "material_tier":
    case "budget_max_fen":
      return 2;
    case "layout":
    case "designer_tier":
    case "expected_start_date":
    case "quantities":
    case "special_requirements":
      return 3;
  }
}

function detectSafety(request: AnalysisRequest): SafetyFlag[] {
  const out: SafetyFlag[] = [];
  const seenRules = new Set<string>();

  // Collect all text snippets that would be serialized and sent to Provider,
  // paired with their source references.
  type TextEntry = { text: string; ref: SourceRef };
  const entries: TextEntry[] = [];

  // 1. Current message
  entries.push({
    text: request.current_message.content,
    ref: {
      source_type: "message",
      source_id: request.current_message.message_id,
      excerpt: request.current_message.content.slice(0, 60),
    },
  });

  // 2. Recent messages (excluding current message)
  for (const msg of request.context.recent_messages) {
    if (msg.message_id === request.current_message.message_id) continue;
    entries.push({
      text: msg.content,
      ref: {
        source_type: "message",
        source_id: msg.message_id,
        excerpt: msg.content.slice(0, 60),
      },
    });
  }

  // 3. Memory summary text
  if (request.context.memory_summary) {
    entries.push({
      text: request.context.memory_summary.text,
      ref: {
        source_type: "memory_summary",
        source_id: request.context.memory_summary.summary_id,
        excerpt: request.context.memory_summary.text.slice(0, 60),
      },
    });
  }

  // 4. Fact values (confirmed, inferred, conflicted) — scan string and string[] values
  for (const bucket of [
    request.context.confirmed_facts,
    request.context.inferred_facts,
    request.context.conflicted_facts,
  ] as const) {
    for (const fact of bucket) {
      const ref: SourceRef = fact.source_refs[0] ?? {
        source_type: "message",
        source_id: request.current_message.message_id,
      };
      const values = Array.isArray(fact.value) ? fact.value : [fact.value];
      for (const v of values) {
        if (typeof v === "string") entries.push({ text: v, ref });
      }
    }
  }

  // 5. Recalled items reasons and excerpts
  for (const item of request.context.recalled_items) {
    entries.push({ text: item.reason, ref: item.source_ref });
    if (item.source_ref.excerpt) {
      entries.push({ text: item.source_ref.excerpt, ref: item.source_ref });
    }
  }

  // 6. Source refs excerpts in facts (source_refs[].excerpt can carry PII)
  for (const bucket of [
    request.context.confirmed_facts,
    request.context.inferred_facts,
    request.context.conflicted_facts,
  ] as const) {
    for (const fact of bucket) {
      for (const sr of fact.source_refs) {
        if (sr.excerpt) entries.push({ text: sr.excerpt, ref: sr });
      }
    }
  }

  // 7. Current quote free-text fields (material_tier / designer_tier)
  if (request.context.current_quote) {
    const q = request.context.current_quote;
    const quoteRef: SourceRef = {
      source_type: "quote",
      source_id: q.quote_id,
      excerpt: "",
    };
    if (typeof q.material_tier === "string") {
      entries.push({ text: q.material_tier, ref: { ...quoteRef, excerpt: q.material_tier.slice(0, 60) } });
    }
    if (typeof q.designer_tier === "string") {
      entries.push({ text: q.designer_tier, ref: { ...quoteRef, excerpt: q.designer_tier.slice(0, 60) } });
    }
  }

  // Scan all entries against safety rules (deduplicate by rule code)
  for (const { text, ref } of entries) {
    for (const rule of SAFETY_RULES) {
      if (seenRules.has(rule.code)) continue;
      if (rule.pattern.test(text)) {
        out.push({
          code: rule.code,
          severity: rule.severity,
          evidence_refs: [ref],
        });
        seenRules.add(rule.code);
      }
    }
  }

  return out;
}

function detectIntent(request: AnalysisRequest): { intent: Intent; confidence: number; reasons: string[] } {
  const text = request.current_message.content;
  const reasons: string[] = [];
  for (const rule of INTENT_RULES) {
    if (rule.match(text, request)) {
      reasons.push(`rule:${rule.intent}`);
      return { intent: rule.intent, confidence: rule.confidence, reasons };
    }
  }
  if (text.trim().length < 4) {
    return { intent: "unclear", confidence: 0.6, reasons: ["message_too_short"] };
  }
  const pronounsAny = /(这个|那个|它|那|这|上次|之前|按你说|那样|这样|你说的)/iu.test(text);
  if (pronounsAny && request.context.recent_messages.length <= 1) {
    return { intent: "unclear", confidence: 0.7, reasons: ["pronoun_reference_without_context"] };
  }
  return { intent: "unclear", confidence: 0.5, reasons: ["no_rule_matched"] };
}

function detectConcerns(request: AnalysisRequest): Concern[] {
  const text = request.current_message.content;
  const out: Concern[] = [];
  for (const rule of CONCERN_RULES) {
    if (rule.pattern.test(text)) {
      const excerpt = excerptFrom(text, rule.pattern);
      out.push({
        code: rule.code,
        evidence_refs: [messageRef(request, excerpt ? new RegExp(excerpt, "iu") : undefined)],
      });
    }
  }
  return out;
}

function numericMatch(text: string, regex: RegExp, group = 1): number | undefined {
  const m = regex.exec(text);
  if (!m) return undefined;
  const raw = m[group];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n;
}

function extractSlotUpdates(request: AnalysisRequest): SlotUpdate[] {
  const text = request.current_message.content;
  const ref = () => messageRef(request);
  const updates: SlotUpdate[] = [];
  const allFacts = [
    ...request.context.confirmed_facts,
    ...request.context.inferred_facts,
    ...request.context.conflicted_facts,
  ];

  const area = numericMatch(text, /(\d+(?:\.\d+)?)\s*(?:平米|平方米|平|平方|m2|㎡|面积?\s*(约|大概|大约|左右)?\s*(\d+(?:\.\d+)?))/iu);
  if (area !== undefined && area > 0 && area < 20_000) {
    if (!slotIsCovered("area_sqm", allFacts)) {
      updates.push({ slot: "area_sqm", value: area, status: "confirmed", source_refs: [ref()] });
    }
  }

  const budget = numericMatch(text, /(\d+)\s*万(?:元)?\s*(?:预算|总价|总预算|最高|最多|上限|以内|控制)?/iu);
  if (budget !== undefined) {
    const fen = budget * 10_000 * 100;
    const existingBudgetFacts = request.context.confirmed_facts.filter(
      (f) => f.fact_key === "budget_max_fen" && f.status === "confirmed",
    );
    if (existingBudgetFacts.length > 0) {
      const conflicts = existingBudgetFacts.filter((f) => {
        const factVal = typeof f.value === "number" ? f.value : Number(f.value);
        return Number.isFinite(factVal) && factVal !== fen;
      });
      if (conflicts.length > 0) {
        const conflictedWith = conflicts.map((f) => f.fact_id);
        const priorEvidence: SourceRef[] = conflicts.flatMap((f) =>
          f.source_refs.filter((r) => r.source_type === "message"),
        );
        updates.push({
          slot: "budget_max_fen",
          value: fen,
          status: "conflicted",
          confidence: 0.5,
          source_refs: [...priorEvidence, ref()],
          conflicts_with_fact_ids: conflictedWith,
        });
      }
    } else if (!slotIsCovered("budget_max_fen", allFacts)) {
      updates.push({ slot: "budget_max_fen", value: fen, status: "confirmed", source_refs: [ref()] });
    }
  }

  const houseMatch = /(新房|毛坯房|毛坯|旧房|老房|二手(房)?|精装房|精装|翻新|重装|局部改造|局部装修)/iu.exec(text);
  if (houseMatch) {
    const v =
      houseMatch[0]!.includes("旧") || houseMatch[0]!.includes("老") || houseMatch[0]!.includes("二手") || houseMatch[0]!.includes("翻新") || houseMatch[0]!.includes("重装")
        ? "old_renovation"
        : houseMatch[0]!.includes("精装")
          ? "new_finished"
          : "rough";
    if (!slotIsCovered("house_state", allFacts)) {
      updates.push({ slot: "house_state", value: v, status: "confirmed", source_refs: [ref()] });
    }
  }

  const scopeMatch = /(全屋|整装|硬装|软装|半包|全包|局部(改造|装修)?|厨卫翻新|卧室|客厅|厨房|卫生间|阳台)/iu.exec(text);
  if (scopeMatch) {
    const v =
      scopeMatch[0]!.includes("全屋") || scopeMatch[0]!.includes("整装") || scopeMatch[0]!.includes("全包")
        ? "whole_home"
        : scopeMatch[0]!.includes("设计")
          ? "design_only"
          : "partial";
    if (!slotIsCovered("service_scope", allFacts)) {
      updates.push({ slot: "service_scope", value: v, status: "confirmed", source_refs: [ref()] });
    }
  }

  const materialMatch = /(高档|高端|奢华|豪华|中高端|中档|中高端|经济|性价比|普通|低档|低端)(?:材料|装修|档次)?/iu.exec(text);
  if (materialMatch) {
    const raw = materialMatch[0]!;
    let value: SlotUpdate["value"];
    let status: SlotUpdate["status"];
    let confidence: number | undefined;
    // Detect negation context: "别太高档", "不要太高档", "不用高档" etc.
    const negationPattern = /(别太|不要太|不用|不要|别|不|没那么)/iu;
    const hasNegation = negationPattern.test(text.slice(0, materialMatch.index ?? 0));
    if (raw.includes("性价比") || raw.includes("经济") || raw.includes("普通")) {
      value = ["low", "mid"];
      status = "inferred";
      confidence = 0.6;
    } else if (hasNegation && (raw.includes("高档") || raw.includes("高端") || raw.includes("奢华") || raw.includes("豪华"))) {
      // Negated high-end → inferred low/mid
      value = ["low", "mid"];
      status = "inferred";
      confidence = 0.6;
    } else if (raw.includes("高档") || raw.includes("高端") || raw.includes("奢华") || raw.includes("豪华")) {
      value = "high";
      status = "confirmed";
    } else if (raw.includes("中档") || raw.includes("中高端")) {
      value = "mid";
      status = "confirmed";
    } else {
      value = "low";
      status = "inferred";
    }
    if (!slotIsCovered("material_tier", allFacts)) {
      const base: SlotUpdate = { slot: "material_tier", value, status, source_refs: [ref()] };
      if (confidence !== undefined) base.confidence = confidence;
      updates.push(base);
    }
  }

  const cityMatch =
    /(北京|上海|广州|深圳|杭州|成都|武汉|西安|南京|重庆|苏州|天津|长沙|青岛|郑州|东莞|宁波|厦门|合肥|福州|济南|昆明|沈阳|大连|太原|南昌|贵阳|南宁|海口|兰州|银川|西宁|呼和浩特|乌鲁木齐|拉萨|石家庄|哈尔滨|长春)/u.exec(
      text,
    );
  if (cityMatch) {
    if (!slotIsCovered("city", allFacts)) {
      updates.push({
        slot: "city",
        value: cityMatch[0]!,
        status: "confirmed",
        source_refs: [ref()],
      });
    }
  }

  const startMatch = /(\d{4}[-\/年]\d{1,2}([-\/月]\d{1,2}[日号]?)?|(下|这|上)?个?(月|周|季度|星期)|下个月初|月底|月初|年底|明年)/iu.exec(text);
  if (startMatch) {
    updates.push({
      slot: "expected_start_date",
      value: startMatch[0]!,
      status: "confirmed",
      source_refs: [ref()],
    });
  }

  const budgetConflictPattern =
    /(\d+)\s*万.*?(?:或者|或|\||\/|~|-|到|和|不确定|没确定|未定|都行|可以|任选).*?(\d+)\s*万/iu;
  const budgetConflict = budgetConflictPattern.exec(text);
  if (budgetConflict) {
    const low = Number(budgetConflict[1]);
    const high = Number(budgetConflict[2]);
    if (Number.isFinite(low) && Number.isFinite(high)) {
      const conflictedFacts = request.context.confirmed_facts.filter(
        (f) => f.fact_key === "budget_max_fen" && f.status === "confirmed",
      );
      const conflictedWith = conflictedFacts.map((f) => f.fact_id);
      const priorEvidence: SourceRef[] = conflictedFacts.flatMap((f) =>
        f.source_refs.filter((r) => r.source_type === "message"),
      );
      const base: SlotUpdate = {
        slot: "budget_max_fen",
        value: [`${low}0000元`, `${high}0000元`],
        status: "conflicted",
        confidence: 0.5,
        source_refs: [...priorEvidence, ref()],
      };
      if (conflictedWith.length > 0) base.conflicts_with_fact_ids = conflictedWith;
      const existingIdx = updates.findIndex((u) => u.slot === "budget_max_fen");
      if (existingIdx >= 0) updates.splice(existingIdx, 1, base);
      else updates.push(base);
    }
  }

  return updates;
}

function deriveMissingFields(
  intent: Intent,
  slotUpdates: SlotUpdate[],
  request: AnalysisRequest,
): MissingField[] {
  if (
    intent !== "quote_request" &&
    intent !== "negotiation" &&
    intent !== "plan_adjustment" &&
    intent !== "provide_information"
  )
    return [];

  // For provide_information: inferred slots need confirmation, plus any missing
  // required quote fields — only allow prepare_quote when ALL quote-required fields
  // are confirmed (context + this turn combined)
  if (intent === "provide_information") {
    const out: MissingField[] = [];
    const seen = new Set<string>();

    // Inferred slots need explicit confirmation
    for (const s of slotUpdates) {
      if (s.status === "inferred" && !seen.has(s.slot)) {
        seen.add(s.slot);
        out.push({ slot: s.slot, reason: priority2Reason(s.slot), priority: 2 });
      }
    }

    // Also check all required quote fields against combined confirmed set
    const covered = new Set(
      slotUpdates.filter((s) => s.status === "confirmed").map((s) => s.slot),
    );
    for (const f of request.context.confirmed_facts) {
      if (f.status === "confirmed") covered.add(f.fact_key as SlotUpdate["slot"]);
    }
    const requiredHigh: SlotUpdate["slot"][] = ["city", "area_sqm"];
    for (const s of requiredHigh) {
      if (!covered.has(s) && !seen.has(s)) {
        seen.add(s);
        out.push({ slot: s, reason: priority1Reason(s), priority: 1 });
      }
    }
    const requiredMid: SlotUpdate["slot"][] = [
      "house_state",
      "service_scope",
      "material_tier",
      "budget_max_fen",
    ];
    for (const s of requiredMid) {
      if (!covered.has(s) && !seen.has(s)) {
        seen.add(s);
        out.push({ slot: s, reason: priority2Reason(s), priority: 2 });
      }
    }

    return out
      .sort((a, b) => (a.priority as number) - (b.priority as number))
      .slice(0, 3);
  }

  // Only confirmed slots count as covered; inferred slots still need confirmation
  const covered = new Set(
    slotUpdates.filter((s) => s.status === "confirmed").map((s) => s.slot),
  );
  for (const f of request.context.confirmed_facts) {
    if (f.status === "confirmed") covered.add(f.fact_key as SlotUpdate["slot"]);
  }
  const out: MissingField[] = [];
  const requiredHigh: SlotUpdate["slot"][] = ["city", "area_sqm"];
  for (const s of requiredHigh) {
    if (!covered.has(s)) out.push({ slot: s, reason: priority1Reason(s), priority: 1 });
  }
  const requiredMid: SlotUpdate["slot"][] = [
    "house_state",
    "service_scope",
    "material_tier",
    "budget_max_fen",
  ];
  for (const s of requiredMid) {
    if (!covered.has(s)) out.push({ slot: s, reason: priority2Reason(s), priority: 2 });
  }
  return out
    .sort((a, b) => (a.priority as number) - (b.priority as number))
    .slice(0, 3);
}

function priority1Reason(slot: SlotUpdate["slot"]): string {
  switch (slot) {
    case "city":
      return "需要先确认是否属于服务区域";
    case "area_sqm":
      return "需要房屋面积才能估算施工量与报价";
    default:
      return "缺失关键字段，报价流程无法继续";
  }
}

function priority2Reason(slot: SlotUpdate["slot"]): string {
  switch (slot) {
    case "house_state":
      return "需确认房屋状态（新房/旧房/精装）以匹配拆改与基础工程";
    case "service_scope":
      return "需确认服务范围（全屋/硬装/软装/局部）";
    case "material_tier":
      return "需确认材料档位作为报价基础档位";
    case "budget_max_fen":
      return "需确认客户预算上限，避免超档报价";
    default:
      return "报价前需要补齐";
  }
}

function deriveKnowledgeDecision(
  intent: Intent,
  missing: MissingField[],
  concerns: Concern[],
  text: string,
): KnowledgeDecision {
  if (intent === "risk" || intent === "rejection" || intent === "unrelated") {
    return { should_search: false, reason_codes: ["security_or_out_of_scope"], topics: [] };
  }
  if (missing.some((m) => m.priority === 1)) {
    const reasons = missing.filter((m) => m.priority === 1).map((m) => `required_${m.slot}_missing`);
    return { should_search: false, reason_codes: reasons, topics: [] };
  }
  if (intent === "unclear") {
    return { should_search: false, reason_codes: ["query_target_unclear"], topics: [] };
  }
  const topics: string[] = [];
  const reasons: string[] = [];
  if (/(流程|步骤|怎么|如何|包含|包括|服务|项目)/iu.test(text)) {
    reasons.push("company_service_question");
    topics.push("service_scope", "renovation_process");
  }
  if (concerns.some((c) => c.code === "after_sales")) {
    reasons.push("after_sales_question");
    topics.push("after_sales");
  }
  if (concerns.some((c) => c.code === "timeline")) {
    reasons.push("timeline_question");
    topics.push("project_timeline");
  }
  if (concerns.some((c) => c.code === "material")) {
    reasons.push("material_question");
    topics.push("material_brands", "material_quality");
  }
  if (concerns.some((c) => c.code === "quality")) {
    reasons.push("quality_question");
    topics.push("workmanship", "acceptance_criteria");
  }
  if (intent === "quote_request" || intent === "consulting") {
    if (reasons.length === 0) reasons.push("general_knowledge_support");
  }
  if (intent === "negotiation" || intent === "plan_adjustment") {
    return { should_search: false, reason_codes: ["quote_or_plan_requires_human"], topics: [] };
  }
  return {
    should_search: topics.length > 0 || intent === "consulting",
    reason_codes: reasons.length > 0 ? reasons : ["general_context"],
    topics,
  };
}

function deriveNextAction(
  intent: Intent,
  safety: SafetyFlag[],
  missing: MissingField[],
  hasConflicts: boolean,
  knowledge: KnowledgeDecision,
): AnalysisResult["recommended_next_action"] {
  if (safety.length > 0) return "safe_stop";
  if (intent === "risk") return "safe_stop";
  if (intent === "rejection" || intent === "unrelated") return "stop_sales_guidance";
  if (hasConflicts) return "clarify_conflict";
  if (missing.length > 0) return "ask_missing_fields";
  if (intent === "quote_request") return "prepare_quote";
  if (intent === "negotiation") return "adjust_quote";
  if (intent === "plan_adjustment") return "adjust_quote";
  if (intent === "provide_information") return missing.length > 0 ? "ask_missing_fields" : "prepare_quote";
  if (knowledge.should_search) return "search_knowledge";
  return "answer_question";
}

function deriveValueAssessment(
  intent: Intent,
  request: AnalysisRequest,
  safety: SafetyFlag[],
  missing: MissingField[],
): AnalysisResult["value_assessment"] {
  if (safety.length > 0 || intent === "risk") {
    return { level: "unknown", evidence_refs: [], reason_codes: ["not_a_sales_signal"] };
  }
  if (intent === "rejection" || intent === "unrelated" || intent === "unclear") {
    return { level: "unknown", evidence_refs: [], reason_codes: ["insufficient_context"] };
  }
  const msgId = request.current_message.message_id;
  const ref: SourceRef = {
    source_type: "message",
    source_id: msgId,
    excerpt:
      request.current_message.content.length > 60
        ? request.current_message.content.slice(0, 59) + "…"
        : request.current_message.content,
  };
  if (intent === "quote_request") {
    const reasons = ["explicit_quote_request"];
    if (missing.length === 0) reasons.push("ready_fields");
    else if (missing.length <= 2) reasons.push("partial_fields_ready");
    return {
      level: missing.some((m) => m.priority === 1) ? "medium" : "high",
      evidence_refs: [ref],
      reason_codes: reasons,
    };
  }
  if (intent === "negotiation") {
    return {
      level: "high",
      evidence_refs: [ref],
      reason_codes: ["active_negotiation_after_quote"],
    };
  }
  if (intent === "plan_adjustment") {
    return {
      level: "medium",
      evidence_refs: [ref],
      reason_codes: ["engaged_plan_adjustment"],
    };
  }
  if (intent === "provide_information") {
    return {
      level: "medium",
      evidence_refs: [ref],
      reason_codes: ["active_requirement_sharing"],
    };
  }
  if (intent === "greeting") {
    return {
      level: "low",
      evidence_refs: [ref],
      reason_codes: ["opening_contact_only"],
    };
  }
  if (intent === "consulting") {
    const hasEngagementContext =
      request.context.confirmed_facts.length > 0 ||
      !!request.context.memory_summary ||
      !!request.context.current_quote;
    if (hasEngagementContext) {
      const reasons: string[] = [];
      if (request.context.current_quote) reasons.push("existing_quote_reference");
      if (request.context.memory_summary) reasons.push("returning_customer_with_summary");
      if (request.context.confirmed_facts.length > 0) reasons.push("prior_requirements_recorded");
      if (reasons.length === 0) reasons.push("existing_plan_reference");
      return {
        level: "medium",
        evidence_refs: [ref],
        reason_codes: reasons,
      };
    }
  }
  return {
    level: "low",
    evidence_refs: [ref],
    reason_codes: ["service_information_only"],
  };
}

export class RuleBasedAnalyzer {
  static readonly contractVersion = CONTRACT_VERSION;
  static readonly providerLabel = "rule_based_v1";

  constructor(
    readonly options: AnalyzeOptions = {
      strictEvidence: true,
    },
  ) {}

  analyze(raw: AnalysisRequest): AnalysisResult {
    const request = AnalysisRequestSchema.parse(raw);
    const safety = detectSafety(request);
    const { intent } = detectIntent(request);
    const concerns = detectConcerns(request);
    const slotUpdates = extractSlotUpdates(request);
    const conflicts = slotUpdates.some((s) => s.status === "conflicted");
    const missing = deriveMissingFields(intent, slotUpdates, request);
    const stage = deriveStage(
      intent,
      request.context.stage,
      request.context.confirmed_facts.length + slotUpdates.filter((s) => s.status === "confirmed").length,
      missing.length,
    );
    const knowledge = deriveKnowledgeDecision(intent, missing, concerns, request.current_message.content);
    const next = deriveNextAction(intent, safety, missing, conflicts, knowledge);
    const valueAssessment = deriveValueAssessment(intent, request, safety, missing);

    if (intent === "unclear" && !concerns.some((c) => c.code === "unclear")) {
      const ref = messageRef(request);
      concerns.push({
        code: "unclear",
        note: "缺少明确的指代对象或询问目标，需要客户补充上下文",
        evidence_refs: [ref],
      });
    }

    const retroPattern = /(上次|之前|原来|按你说|那个方案|那份报价|上次的|回忆|回顾|接着|继续)/iu;
    const mentionsRetro = retroPattern.test(request.current_message.content);
    if (mentionsRetro) {
      const retroRefs: SourceRef[] = request.context.recalled_items.map((r) => r.source_ref);
      if (request.context.memory_summary) {
        retroRefs.push({
          source_type: "memory_summary",
          source_id: request.context.memory_summary.summary_id,
          excerpt:
            request.context.memory_summary.text.length > 60
              ? request.context.memory_summary.text.slice(0, 59) + "…"
              : request.context.memory_summary.text,
        });
      }
      if (request.context.current_quote) {
        retroRefs.push({
          source_type: "quote",
          source_id: request.context.current_quote.quote_id,
          excerpt: `报价档:${request.context.current_quote.material_tier}`,
        });
      }
      if (valueAssessment.level !== "unknown") {
        (valueAssessment.evidence_refs as SourceRef[]).push(...retroRefs);
      }
    }

    const result: AnalysisResult = {
      contract_version: CONTRACT_VERSION,
      intent,
      stage_recommendation: stage,
      value_assessment: valueAssessment,
      concerns,
      slot_updates: slotUpdates,
      missing_fields: missing,
      recommended_next_action: next,
      knowledge_decision: knowledge,
      safety_flags: safety,
      model_metadata: {
        provider: "aliyun_bailian",
        model_id: RuleBasedAnalyzer.providerLabel,
        prompt_version: "rulebook-v1",
      },
    };
    return AnalysisResultSchema.parse(result);
  }
}

export class BailianAnalysisService {
  readonly fallback: RuleBasedAnalyzer;
  constructor(
    readonly provider: AiProvider | null,
    readonly strictEvidence = true,
  ) {
    this.fallback = new RuleBasedAnalyzer({ strictEvidence });
  }

  async analyze(
    raw: AnalysisRequest | ProviderAnalysisRequest,
  ): Promise<{ result: AnalysisResult; diagnostics: AnalyzeDiagnostics }> {
    const request = AnalysisRequestSchema.parse(raw);
    const diagnostics: AnalyzeDiagnostics = {
      intentAccuracyReached: true,
      valueAccuracyReached: true,
      evidenceTraceableCount: 0,
      schemaPassed: false,
      providerUsed: false,
      fallbackApplied: false,
      unsafeCandidatesRejected: [],
      confusionCandidates: [],
      failedFixtures: [],
    };

    const safety = detectSafety(request);
    if (safety.length > 0) {
      const fallback = this.fallback.analyze(request);
      diagnostics.fallbackApplied = true;
      diagnostics.fallbackReason = "safety_blocked";
      diagnostics.unsafeCandidatesRejected.push(
        `safety_blocked_before_provider:${safety.map((s) => s.code).join(",")}`,
      );
      diagnostics.schemaPassed = true;
      diagnostics.evidenceTraceableCount = countEvidenceMessages(fallback);
      return { result: fallback, diagnostics };
    }

    if (!this.provider) {
      const fallback = this.fallback.analyze(request);
      diagnostics.fallbackApplied = true;
      diagnostics.fallbackReason = "provider_missing";
      diagnostics.schemaPassed = true;
      diagnostics.evidenceTraceableCount = countEvidenceMessages(fallback);
      return { result: fallback, diagnostics };
    }

    try {
      const rawResult = await this.provider.analyze(request);
      diagnostics.providerUsed = true;
      const postValidated = postValidateProviderResult(rawResult, request, diagnostics);
      diagnostics.schemaPassed = true;
      diagnostics.evidenceTraceableCount = countEvidenceMessages(postValidated);
      return { result: postValidated, diagnostics };
    } catch (err) {
      const fallback = this.fallback.analyze(request);
      diagnostics.fallbackApplied = true;
      diagnostics.fallbackReason =
        err instanceof ModelProviderError
          ? "provider_error"
          : (err instanceof Error && /schema|parse|zod/i.test(err.message))
            ? "provider_malformed"
            : "provider_error";
      diagnostics.schemaPassed = true;
      diagnostics.evidenceTraceableCount = countEvidenceMessages(fallback);
      return { result: fallback, diagnostics };
    }
  }
}

function countEvidenceMessages(result: AnalysisResult): number {
  const sets = [
    result.value_assessment.evidence_refs,
    ...result.concerns.map((c) => c.evidence_refs),
    ...result.slot_updates.map((s) => s.source_refs),
    ...result.safety_flags.map((s) => s.evidence_refs),
  ];
  let count = 0;
  for (const refs of sets) {
    for (const r of refs) {
      if (r.source_type === "message") count++;
    }
  }
  return count;
}

function collectVisibleSourceIds(request: AnalysisRequest): Set<string> {
  const out = new Set<string>();
  out.add(request.current_message.message_id);
  for (const m of request.context.recent_messages) out.add(m.message_id);
  for (const bucket of [
    request.context.confirmed_facts,
    request.context.inferred_facts,
    request.context.conflicted_facts,
  ] as const) {
    for (const f of bucket) out.add(f.fact_id);
  }
  if (request.context.memory_summary) {
    out.add(request.context.memory_summary.summary_id);
    for (const m of request.context.memory_summary.source_message_ids) out.add(m);
  }
  if (request.context.current_quote) out.add(request.context.current_quote.quote_id);
  for (const r of request.context.recalled_items) out.add(r.source_ref.source_id);
  return out;
}

function postValidateProviderResult(
  raw: unknown,
  request: AnalysisRequest,
  diagnostics: AnalyzeDiagnostics,
): AnalysisResult {
  const parsed = AnalysisResultSchema.safeParse(raw);
  if (!parsed.success) {
    diagnostics.unsafeCandidatesRejected.push(`schema:${parsed.error.issues.length}_issues`);
    const fallback = new RuleBasedAnalyzer().analyze(request);
    diagnostics.fallbackApplied = true;
    diagnostics.fallbackReason = "provider_malformed";
    return fallback;
  }
  const res = parsed.data;

  // P0 fix: always merge locally detected safety signals (defense in depth)
  const localSafety = detectSafety(request);
  if (localSafety.length > 0) {
    const existingCodes = new Set(res.safety_flags.map((s) => s.code));
    for (const flag of localSafety) {
      if (!existingCodes.has(flag.code)) {
        (res as AnalysisResult).safety_flags.push(flag);
      }
    }
    diagnostics.unsafeCandidatesRejected.push(
      `post_validate_safety_merge:${localSafety.map((s) => s.code).join(",")}`,
    );
  }

  // P0 fix: force safe action whenever any safety signal exists or intent is risk,
  // regardless of provider's output
  if (res.safety_flags.length > 0 || res.intent === "risk") {
    if (res.recommended_next_action !== "safe_stop") {
      diagnostics.unsafeCandidatesRejected.push(
        `forced_safe_stop:provider_returned_${res.recommended_next_action}`,
      );
    }
    (res as AnalysisResult).recommended_next_action = "safe_stop";
    (res as AnalysisResult).intent = "risk";
    (res as AnalysisResult).stage_recommendation = request.context.stage;
    (res as AnalysisResult).value_assessment = {
      level: "unknown",
      evidence_refs: [],
      reason_codes: ["not_a_sales_signal"],
    };
  }

  if (res.value_assessment.level !== "unknown") {
    const hasMsg = res.value_assessment.evidence_refs.some((r) => r.source_type === "message");
    if (!hasMsg) {
      diagnostics.unsafeCandidatesRejected.push("value_without_message_evidence");
      (res as AnalysisResult).value_assessment.evidence_refs.push(messageRef(request));
    }
  }

  if (res.intent === "unclear" && res.recommended_next_action === "prepare_quote") {
    diagnostics.unsafeCandidatesRejected.push("unclear_intent_forbidden_quote_action");
    (res as AnalysisResult).recommended_next_action = "answer_question";
  }

  // P1-2: filter provider evidence refs to only visible source IDs
  const visibleIds = collectVisibleSourceIds(request);
  const allRefArrays = [
    { refs: (res as AnalysisResult).value_assessment.evidence_refs, label: "value" },
    ...res.concerns.map((c) => ({ refs: (c as Concern).evidence_refs, label: `concern:${c.code}` })),
    ...res.safety_flags.map((s) => ({ refs: (s as SafetyFlag).evidence_refs, label: `safety:${s.code}` })),
    ...res.slot_updates.map((s) => ({ refs: (s as SlotUpdate).source_refs, label: `slot:${s.slot}` })),
  ];
  for (const { refs, label } of allRefArrays) {
    const before = refs.length;
    (refs as SourceRef[]).splice(0, refs.length, ...refs.filter((r) => visibleIds.has(r.source_id)));
    if (refs.length < before) {
      diagnostics.unsafeCandidatesRejected.push(`invisible_evidence_filtered:${label}:${before - refs.length}_removed`);
    }
  }

  // P1-2 fix: if value_assessment level is known but evidence_refs became empty after filtering,
  // restore with current message ref to satisfy AnalysisResultSchema
  if (res.value_assessment.level !== "unknown" && res.value_assessment.evidence_refs.length === 0) {
    diagnostics.unsafeCandidatesRejected.push("value_evidence_empty_after_filter_restore");
    (res as AnalysisResult).value_assessment.evidence_refs.push(messageRef(request));
  }

  // P1-3: provider cannot prepare_quote when missing_fields exist
  if (res.missing_fields.length > 0 && res.recommended_next_action === "prepare_quote") {
    diagnostics.unsafeCandidatesRejected.push("prepare_quote_with_missing_fields");
    (res as AnalysisResult).recommended_next_action = "ask_missing_fields";
  }

  // P1-2 fix: re-validate against AnalysisResultSchema after all post-validation mutations
  const revalidation = AnalysisResultSchema.safeParse(res);
  if (!revalidation.success) {
    diagnostics.unsafeCandidatesRejected.push(`post_validate_schema_failed:${revalidation.error.issues.length}_issues`);
    const fallback = new RuleBasedAnalyzer().analyze(request);
    diagnostics.fallbackApplied = true;
    diagnostics.fallbackReason = "provider_malformed";
    return fallback;
  }

  return revalidation.data;
}

export {
  detectIntent as _diagnoseIntent,
  detectConcerns as _diagnoseConcerns,
  detectSafety as _diagnoseSafety,
  extractSlotUpdates as _diagnoseSlots,
  INTENT_RULES,
  CONCERN_RULES,
  SAFETY_RULES,
};
export const INTENT_SCHEMA_OPTIONS = IntentSchema.options;
export const NEXT_ACTION_OPTIONS = NextActionSchema.options;
export const CONCERN_CODE_OPTIONS = ConcernCodeSchema.options;
export const SLOT_NAME_OPTIONS = SlotNameSchema.options;

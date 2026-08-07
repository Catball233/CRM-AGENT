"use client";

import type { QuoteItem, QuoteResult } from "@crm-agent/contracts";
import { formatFenToYuan } from "../chat/format-fen";

const CATEGORY_LABELS: Record<QuoteItem["category"], string> = {
  design: "设计",
  material: "材料",
  construction: "施工",
  surcharge: "附加费",
  adjustment: "调整",
};

const HOUSE_STATE_LABELS: Record<QuoteResult["parameters_snapshot"]["house_state"], string> = {
  rough: "毛坯",
  new_finished: "新房",
  old_renovation: "旧房翻新",
};

const SERVICE_SCOPE_LABELS: Record<QuoteResult["parameters_snapshot"]["service_scope"], string> = {
  whole_home: "全屋",
  partial: "局部",
  design_only: "仅设计",
};

const MATERIAL_TIER_LABELS: Record<string, string> = {
  economy: "经济",
  mid: "中档",
  premium: "高档",
};

function formatQuoteDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export interface QuoteCardProps {
  quote: QuoteResult;
}

/**
 * 客户可见报价卡片。按 #17 验收范围展示规则版本与证据引用，
 * 与报价版本、明细、合计、配置、假设、不含项与免责声明一并渲染。
 * 注：原 C06-PRIVACY-07 隐藏基线未在 #17 或权威文档登记，本卡按 #17 原始范围实现，
 * 待 A/C 在 PR 评审裁定是否缩减为「客户可见追溯摘要」。
 */
export function QuoteCard({ quote }: QuoteCardProps) {
  const isAdjustment = quote.parent_quote_id !== null;
  return (
    <article className="quote-card" aria-label="预估报价">
      <header className="quote-header">
        <div>
          <p className="eyebrow">ESTIMATED QUOTE</p>
          <h3>本地测试预估报价</h3>
        </div>
        <span className="quote-version-chip">
          v{quote.quote_version}
          {isAdjustment ? " · 调整版" : ""}
        </span>
      </header>

      <div className="quote-total">
        <span>预估合计</span>
        <strong>{formatFenToYuan(quote.estimated_total_fen)}</strong>
        <small>{quote.currency === "CNY" ? "人民币" : quote.currency}</small>
      </div>

      <dl className="quote-params">
        <div><dt>城市</dt><dd>{quote.parameters_snapshot.city}</dd></div>
        <div><dt>面积</dt><dd>{quote.parameters_snapshot.area_sqm} ㎡</dd></div>
        <div><dt>房屋状态</dt><dd>{HOUSE_STATE_LABELS[quote.parameters_snapshot.house_state]}</dd></div>
        <div><dt>装修范围</dt><dd>{SERVICE_SCOPE_LABELS[quote.parameters_snapshot.service_scope]}</dd></div>
        <div><dt>材料档位</dt><dd>{MATERIAL_TIER_LABELS[quote.parameters_snapshot.material_tier] ?? quote.parameters_snapshot.material_tier}</dd></div>
      </dl>

      <div className="quote-items">
        <p className="panel-heading"><span>报价明细</span><span>{quote.items.length} 项</span></p>
        <ul>
          {quote.items.map((item) => (
            <li key={item.quote_item_id}>
              <div className="quote-item-label">
                <span className="quote-item-cat">{CATEGORY_LABELS[item.category]}</span>
                <span>{item.label}</span>
              </div>
              <div className="quote-item-amount">
                {item.unit_price_fen !== undefined && item.quantity !== undefined && item.unit ? (
                  <small>{item.quantity} {item.unit} × {formatFenToYuan(item.unit_price_fen)}</small>
                ) : null}
                <strong>{formatFenToYuan(item.amount_fen)}</strong>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {quote.assumptions.length > 0 ? (
        <div className="quote-notes">
          <p className="panel-heading"><span>假设</span></p>
          <ul>{quote.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul>
        </div>
      ) : null}

      {quote.exclusions.length > 0 ? (
        <div className="quote-notes">
          <p className="panel-heading"><span>不含</span></p>
          <ul>{quote.exclusions.map((exclusion, index) => <li key={index}>{exclusion}</li>)}</ul>
        </div>
      ) : null}

      <div className="quote-notes">
        <p className="panel-heading"><span>规则版本</span><span>{quote.rule_versions.length} 项</span></p>
        <ul>
          {quote.rule_versions.map((rule, index) => (
            <li key={`${rule.rule_id}-${index}`}>
              <span>{rule.rule_id}</span>
              <small>版本 {rule.version}</small>
            </li>
          ))}
        </ul>
      </div>

      <div className="quote-notes">
        <p className="panel-heading"><span>证据引用</span><span>{quote.knowledge_evidence_ids.length} 项</span></p>
        <ul>
          {quote.knowledge_evidence_ids.map((id, index) => (
            <li key={index}>{id.slice(0, 8)}</li>
          ))}
        </ul>
      </div>

      <p className="quote-disclaimer">{quote.disclaimer}</p>

      <footer className="quote-footer">
        <small>报价编号 {quote.quote_id.slice(0, 8)}</small>
        <time>{formatQuoteDate(quote.created_at)}</time>
      </footer>
    </article>
  );
}

export interface QuoteStatusCardProps {
  kind: "unavailable" | "knowledge_insufficient";
  message?: string;
}

export function QuoteStatusCard({ kind, message }: QuoteStatusCardProps) {
  const config = {
    unavailable: {
      label: "暂不可生成报价",
      note: message ?? "当前没有可用的已激活报价规则，不会给出猜测价格。",
      icon: "∅",
    },
    knowledge_insufficient: {
      label: "知识不足",
      note: message ?? "暂无足够的企业知识支撑本次回答，已安全降级。",
      icon: "?",
    },
  }[kind];

  return (
    <article className={`quote-status-card kind-${kind}`} role="status">
      <span className="quote-status-icon" aria-hidden="true">{config.icon}</span>
      <div>
        <strong>{config.label}</strong>
        <p>{config.note}</p>
      </div>
    </article>
  );
}

export function QuoteLoadingCard() {
  return (
    <article className="quote-card quote-loading" role="status" aria-live="polite">
      <span className="loading-orbit" aria-hidden="true" />
      <span>正在准备报价…</span>
    </article>
  );
}
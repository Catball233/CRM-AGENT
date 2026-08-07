/* @vitest-environment jsdom */

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { validQuoteResult } from "@crm-agent/test-fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { QuoteCard, QuoteLoadingCard, QuoteStatusCard } from "./quote-card";

afterEach(() => cleanup());

describe("QuoteCard", () => {
  it("renders the formatted total and item amounts in yuan", () => {
    render(<QuoteCard quote={validQuoteResult} />);
    expect(screen.getAllByText("¥115,200.00")).toHaveLength(2);
  });

  it("renders quote version v1 without the adjustment label", () => {
    render(<QuoteCard quote={validQuoteResult} />);
    expect(screen.getByText("v1")).toBeInTheDocument();
    expect(screen.queryByText(/调整版/)).not.toBeInTheDocument();
  });

  it("renders an adjustment version when parent_quote_id is set", () => {
    const baseItem = validQuoteResult.items[0]!;
    const adjusted = {
      ...validQuoteResult,
      quote_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      quote_version: 2,
      parent_quote_id: validQuoteResult.quote_id,
      estimated_total_fen: 10_620_000,
      items: [
        {
          ...baseItem,
          amount_fen: 10_620_000,
          unit_price_fen: 118_000,
          label: "全屋施工测试项（调整）",
          calculation_inputs: { area_sqm: 90, unit_price_fen: 118_000 },
        },
      ],
    };
    render(<QuoteCard quote={adjusted} />);
    expect(screen.getByText("v2 · 调整版")).toBeInTheDocument();
    expect(screen.getAllByText("¥106,200.00")).toHaveLength(2);
  });

  it("renders parameters, assumptions, exclusions and disclaimer", () => {
    render(<QuoteCard quote={validQuoteResult} />);
    expect(screen.getByText("默认测试城市")).toBeInTheDocument();
    expect(screen.getByText("90 ㎡")).toBeInTheDocument();
    expect(screen.getByText("旧房翻新")).toBeInTheDocument();
    expect(screen.getByText("全屋")).toBeInTheDocument();
    expect(screen.getByText("仅用于本地验证")).toBeInTheDocument();
    expect(screen.getByText("不包含正式量房后的变更")).toBeInTheDocument();
    expect(screen.getByText(validQuoteResult.disclaimer)).toBeInTheDocument();
  });

  it("shows rule versions and evidence references per #17 acceptance scope", () => {
    const { container } = render(<QuoteCard quote={validQuoteResult} />);
    expect(screen.getByText("规则版本")).toBeInTheDocument();
    expect(container.textContent).toContain("RULE-WHOLE-MID-001");
    expect(screen.getByText("证据引用")).toBeInTheDocument();
    expect(container.textContent).toContain(validQuoteResult.knowledge_evidence_ids[0]!.slice(0, 8));
    expect(container.textContent).not.toContain(validQuoteResult.rule_versions[0]!.rule_version_id);
  });

  it("maps material_tier to a Chinese label", () => {
    render(<QuoteCard quote={validQuoteResult} />);
    expect(screen.getByText("中档")).toBeInTheDocument();
  });
});

describe("QuoteStatusCard", () => {
  it("renders the unavailable state with a safe message", () => {
    render(<QuoteStatusCard kind="unavailable" />);
    expect(screen.getByText("暂不可生成报价")).toBeInTheDocument();
    expect(screen.getByText(/没有可用的已激活报价规则/)).toBeInTheDocument();
  });

  it("renders the knowledge insufficient state", () => {
    render(<QuoteStatusCard kind="knowledge_insufficient" />);
    expect(screen.getByText("知识不足")).toBeInTheDocument();
    expect(screen.getByText(/安全降级/)).toBeInTheDocument();
  });
});

describe("QuoteLoadingCard", () => {
  it("renders an accessible loading status", () => {
    render(<QuoteLoadingCard />);
    expect(screen.getByRole("status")).toHaveTextContent("正在准备报价");
  });
});
import { describe, expect, it } from "vitest";
import { formatFenToYuan } from "./format-fen";

describe("formatFenToYuan", () => {
  it("formats zero as 0.00", () => {
    expect(formatFenToYuan(0)).toBe("¥0.00");
  });

  it("pads single-digit fen to two decimals", () => {
    expect(formatFenToYuan(1)).toBe("¥0.01");
    expect(formatFenToYuan(9)).toBe("¥0.09");
  });

  it("keeps two-digit fen under one yuan", () => {
    expect(formatFenToYuan(99)).toBe("¥0.99");
  });

  it("crosses the yuan boundary at 100 fen", () => {
    expect(formatFenToYuan(100)).toBe("¥1.00");
    expect(formatFenToYuan(999)).toBe("¥9.99");
  });

  it("groups thousands without floating point error", () => {
    expect(formatFenToYuan(11_520_000)).toBe("¥115,200.00");
    expect(formatFenToYuan(11_520_001)).toBe("¥115,200.01");
  });

  it("rejects non-integer or negative amounts", () => {
    expect(() => formatFenToYuan(-1)).toThrow(RangeError);
    expect(() => formatFenToYuan(1.5)).toThrow(RangeError);
  });
});
const THOUSANDS_SEPARATOR = ",";

function groupThousands(value: string): string {
  return value.replace(/\B(?=(\d{3})+(?!\d))/g, THOUSANDS_SEPARATOR);
}

/**
 * 将整数分安全格式化为人民币元展示串。
 *
 * 金额在契约中以非负整数分表示（MoneyFenSchema），此处仅做整数到字符串的
 * 转换，避免浮点误差，并补齐两位小数与千分位。
 */
export function formatFenToYuan(fen: number): string {
  if (!Number.isInteger(fen) || fen < 0) {
    throw new RangeError("金额必须为非负整数分");
  }
  const digits = fen.toString();
  let yuan: string;
  let fenPart: string;
  if (digits.length <= 2) {
    yuan = "0";
    fenPart = digits.padStart(2, "0");
  } else {
    yuan = digits.slice(0, -2);
    fenPart = digits.slice(-2);
  }
  return `¥${groupThousands(yuan)}.${fenPart}`;
}
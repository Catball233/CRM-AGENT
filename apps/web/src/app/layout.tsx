import type { ReactNode } from "react";

export const metadata = {
  title: "CRM-AGENT 本地 MVP",
  description: "装修行业 AI 销售与预估报价本地验证版",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

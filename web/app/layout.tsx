import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "2ApiCheck",
  description: "Credential checker and cleanup tool for codex / gemini auth archives"
};

export default function RootLayout({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}

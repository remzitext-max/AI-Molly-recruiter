import "./globals.css";
import type { ReactNode } from "react";

export const metadata = { title: "TBT Recruiting Assistant", robots: { index: false, follow: false } };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

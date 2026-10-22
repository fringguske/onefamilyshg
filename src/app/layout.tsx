import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "One Family Merry-Go-Round",
  description: "Savings, loans, advances and monthly records for the group.",
};

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#3E5068" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}

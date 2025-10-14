import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Data Standardization Toolkit",
  description:
    "Normalize monday.com board data with repeatable recipes, usage metering, and monetization-ready gates."
};

type RootLayoutProps = {
  children: React.ReactNode;
};

export default function RootLayout({ children }: RootLayoutProps) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen bg-background font-sans text-foreground antialiased">
        {children}
      </body>
    </html>
  );
}

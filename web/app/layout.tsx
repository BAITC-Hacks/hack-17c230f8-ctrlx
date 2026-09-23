import type { Metadata } from "next";
import { Shell } from "@/components/shell";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

export const metadata: Metadata = {
  title: "WindCast · прогноз выработки ВЭС «Нурлы»",
  description: "Агент прогноза выработки ветроэлектростанции на 48 часов для Самрук-Энерго",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="ru" className="h-full antialiased">
      <body className="min-h-full bg-background font-sans text-foreground">
        <Shell>{children}</Shell>
        <Toaster />
      </body>
    </html>
  );
}

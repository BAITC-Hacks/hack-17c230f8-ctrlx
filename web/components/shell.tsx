"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { Activity, BarChart3, Bot, CalendarRange, FileSpreadsheet, MessageSquare, Plug } from "lucide-react";
import { api, STATION } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV = [
  { href: "/", label: "Февраль", icon: CalendarRange },
  { href: "/issues", label: "Прогноз на 48 ч", icon: Activity },
  { href: "/bid", label: "Заявка на завтра", icon: FileSpreadsheet },
  { href: "/agent", label: "Что сделал агент", icon: Bot },
  { href: "/quality", label: "Насколько точно", icon: BarChart3 },
  { href: "/ask", label: "Вопрос агенту", icon: MessageSquare },
  { href: "/integration", label: "Для ИТ", icon: Plug },
];

function ModeBadge() {
  const [mode, setMode] = useState<"llm" | "demo" | "offline" | null>(null);
  useEffect(() => {
    api.health().then((h) => setMode(h.mode)).catch(() => setMode("offline"));
  }, []);
  if (!mode) return null;
  const text =
    mode === "llm" ? "ИИ-сводки включены" : mode === "demo" ? "работает без ключей" : "сервис прогноза не запущен";
  return (
    <span
      className={cn(
        "rounded-md px-2 py-1 text-xs font-medium",
        mode === "offline" ? "bg-destructive/10 text-destructive" : "bg-accent text-accent-foreground",
      )}
    >
      {text}
    </span>
  );
}

export function Shell({ children }: { children: React.ReactNode }) {
  const path = usePathname();
  const active = (href: string) => (href === "/" ? path === "/" : path.startsWith(href));
  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col bg-sidebar px-3 py-5 text-sidebar-foreground md:flex">
        <Link href="/" className="px-3">
          <div className="text-lg font-semibold tracking-tight text-white">WindCast</div>
          <div className="text-xs text-sidebar-foreground/70">прогноз выработки на 48 часов</div>
        </Link>
        <nav className="mt-6 flex flex-col gap-1">
          {NAV.map(({ href, label, icon: Icon }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active(href)
                  ? "bg-sidebar-accent text-white"
                  : "text-sidebar-foreground/80 hover:bg-sidebar-accent/60 hover:text-white",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto px-3 text-xs leading-relaxed text-sidebar-foreground/60">
          {STATION} · 5 МВт
          <br />
          Samruk-Green Energy, «Самрук-Энерго»
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b bg-card px-4 py-3 md:px-8">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{STATION} · 2 × Goldwind GW109/2500</div>
            <div className="text-xs text-muted-foreground">Февраль 2026 · время Алматы</div>
          </div>
          <ModeBadge />
        </header>
        <nav className="flex gap-1 overflow-x-auto border-b bg-card px-2 py-2 md:hidden">
          {NAV.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className={cn(
                "whitespace-nowrap rounded-md px-3 py-1.5 text-sm",
                active(href) ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {label}
            </Link>
          ))}
        </nav>
        <main className="wc-enter mx-auto w-full max-w-6xl flex-1 px-5 py-10 md:px-12">{children}</main>
      </div>
    </div>
  );
}

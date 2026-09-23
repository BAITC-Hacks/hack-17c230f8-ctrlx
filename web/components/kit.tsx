"use client";

import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/utils";

/** Page title + one short sentence. Nothing else goes above the hero visual. */
export function PageHeader({ title, lead, actions }: {
  title: string;
  lead?: string;
  actions?: React.ReactNode;
}) {
  return (
    <header className="flex flex-col gap-4 pb-8 sm:flex-row sm:items-end sm:justify-between">
      <div className="max-w-2xl">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        {lead && <p className="mt-2 text-base text-muted-foreground">{lead}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </header>
  );
}

/** A section separated by whitespace and one hairline — not another card. */
export function Section({ title, help, children, className }: {
  title?: string;
  help?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-border/70 py-10 first:border-t-0 first:pt-2", className)}>
      {(title || help) && (
        <div className="mb-6 flex items-center gap-2">
          {title && <h2 className="text-lg font-semibold">{title}</h2>}
          {help && <Explain>{help}</Explain>}
        </div>
      )}
      {children}
    </section>
  );
}

/** Big number with a plain-language label; no box around it. */
export function Stat({ label, value, unit, note, tone }: {
  label: string;
  value: React.ReactNode;
  unit?: string;
  note?: React.ReactNode;
  tone?: "default" | "accent";
}) {
  return (
    <div className="min-w-0">
      <div className="text-sm text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-4xl font-semibold tracking-tight tabular-nums",
        tone === "accent" && "text-primary")}>
        {value}
        {unit && <span className="ml-1 text-lg font-normal text-muted-foreground">{unit}</span>}
      </div>
      {note && <div className="mt-1 text-sm text-muted-foreground">{note}</div>}
    </div>
  );
}

export function StatRow({ children }: { children: React.ReactNode }) {
  return <div className="grid grid-cols-2 gap-x-8 gap-y-8 lg:grid-cols-4">{children}</div>;
}

/** «Как читать»: explanations stay one click away instead of filling the screen. */
export function Explain({ children, label = "Как читать" }: { children: React.ReactNode; label?: string }) {
  return (
    <details className="group relative inline-block">
      <summary className="flex cursor-pointer list-none items-center gap-1 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <HelpCircle className="size-4" aria-hidden />
        {label}
      </summary>
      <div className="fixed inset-x-4 z-20 mt-2 rounded-lg border bg-popover p-4 text-sm leading-relaxed text-popover-foreground shadow-lg sm:absolute sm:inset-x-auto sm:left-0 sm:w-80">
        {children}
      </div>
    </details>
  );
}

/** Plain words for the few terms the platform needs. */
export const PLAIN = {
  today: "сегодня",
  tomorrow: "завтра",
  band: "коридор: в 8 случаях из 10 факт внутри",
  recompute: "уточнение в 12:00 по свежему прогнозу погоды",
  error: "средняя ошибка, % от мощности станции",
  naive: "прогноз «как вчера»",
};

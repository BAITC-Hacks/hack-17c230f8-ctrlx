"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CloudSun,
  type LucideIcon,
  RefreshCw,
  TriangleAlert,
  Wind,
  WindArrowDown,
  Zap,
} from "lucide-react";
import { Heatmap, type HeatCell } from "@/components/charts";
import { PageHeader, Section, Stat, StatRow } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  type ForecastIssue,
  type ForecastRow,
  type IssueListItem,
  MODEL_LABEL,
  RATED_MW,
  STATION,
  api,
  dayLabel,
  localDay,
  localHour,
  mw,
  planRows,
} from "@/lib/api";

const MONTH = "2026-02";
// Below 5 % of rated power the turbines are practically standing: counted as calm.
const CALM = 0.05;
const DAYS_IN_MONTH = new Date(Date.UTC(2026, 2, 0)).getUTCDate();

const TITLE = "Февраль 2026";
const LEAD = `Сколько энергии ${STATION} даст в каждый час февраля`;

const HOW: { icon: LucideIcon; text: string }[] = [
  { icon: CloudSun, text: "В полночь агент берёт прогноз погоды" },
  { icon: Zap, text: "Считает выработку на 48 часов" },
  { icon: RefreshCw, text: "В 12:00 уточняет, если вышел свежий прогноз" },
];

const WEEKDAY = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function fmt(value: number, digits = 0): string {
  return new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function weekday(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  return WEEKDAY[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

function issuesHref(issueDate: string): string {
  return `/issues?date=${issueDate}`;
}

interface DayPlan {
  day: string;
  issueDate: string;
  energy: number; // MWh
  hours: number;
}

interface Overview {
  cells: HeatCell[];
  issueByDay: Map<string, string>;
  days: DayPlan[];
  energy: number;
  hours: number;
  mean: number;
  calmHours: number;
  total: number;
  recomputed: number;
  fallbacks: { issueDate: string; model: string }[];
  models: string[];
}

function buildOverview(issues: IssueListItem[], forecasts: ForecastIssue[]): Overview {
  // One value per local hour; if two issues ever planned the same hour, the later issue wins.
  const byHour = new Map<string, { row: ForecastRow; issueDate: string }>();
  const ordered = [...forecasts].sort((a, b) => a.issue_date.localeCompare(b.issue_date));
  for (const f of ordered) {
    for (const row of planRows(f.rows)) {
      const day = localDay(row.target_time_local);
      if (!day.startsWith(MONTH)) continue;
      byHour.set(`${day}|${localHour(row.target_time_local)}`, { row, issueDate: f.issue_date });
    }
  }

  const cells: HeatCell[] = [];
  const issueByDay = new Map<string, string>();
  const perDay = new Map<string, { row: ForecastRow; issueDate: string }[]>();
  for (const v of byHour.values()) {
    const day = localDay(v.row.target_time_local);
    cells.push({ day, hour: localHour(v.row.target_time_local), value: v.row.power_farm });
    issueByDay.set(day, v.issueDate);
    const list = perDay.get(day) ?? [];
    list.push(v);
    perDay.set(day, list);
  }

  const days: DayPlan[] = [...perDay.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, list]) => ({
      day,
      issueDate: issueByDay.get(day) ?? list[0].issueDate,
      energy: list.reduce((s, v) => s + v.row.power_farm, 0) * RATED_MW,
      hours: list.length,
    }));

  const rows = [...byHour.values()].map((v) => v.row);
  const shareSum = rows.reduce((s, r) => s + r.power_farm, 0);
  const fallbacks = ordered
    .filter((f) => f.fallback_used || f.rows.some((r) => r.fallback_used))
    .map((f) => ({ issueDate: f.issue_date, model: f.model_name }));

  return {
    cells,
    issueByDay,
    days,
    energy: shareSum * RATED_MW,
    hours: rows.length,
    mean: rows.length ? shareSum / rows.length : 0,
    calmHours: rows.filter((r) => r.power_farm < CALM).length,
    total: issues.length,
    recomputed: forecasts.filter((f) => f.rows.some((r) => r.revision === 1)).length,
    fallbacks,
    models: [...new Set(forecasts.map((f) => f.model_name))],
  };
}

type Load =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: Overview };

function errorText(e: unknown): string {
  if (e instanceof ApiError && e.status === 0) return "Сервис прогноза не отвечает.";
  if (e instanceof ApiError) return `Сервис ответил ошибкой ${e.status}.`;
  return e instanceof Error ? e.message : "Неизвестная ошибка.";
}

// ---- pieces ---------------------------------------------------------------------------------

function HowItWorks() {
  return (
    <div className="flex flex-col gap-6 rounded-2xl bg-muted/60 px-5 py-6 sm:px-8 lg:flex-row lg:items-center lg:gap-10">
      <ol className="grid flex-1 gap-5 sm:grid-cols-3 sm:gap-8">
        {HOW.map(({ icon: Icon, text }, i) => (
          <li key={text} className="flex items-center gap-4">
            <span className="relative flex size-11 shrink-0 items-center justify-center rounded-full bg-background text-primary shadow-xs">
              <Icon className="size-5" aria-hidden />
              <span className="absolute -top-1 -right-1 flex size-5 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-primary-foreground tabular-nums">
                {i + 1}
              </span>
            </span>
            <span className="leading-snug text-pretty">{text}</span>
          </li>
        ))}
      </ol>
      <Link
        href="/agent"
        className="flex shrink-0 items-center gap-1 self-start rounded-md text-sm font-medium text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 lg:self-center"
      >
        Подробнее
        <ChevronRight className="size-4" aria-hidden />
      </Link>
    </div>
  );
}

function DayList({ title, icon: Icon, days }: { title: string; icon: LucideIcon; days: DayPlan[] }) {
  return (
    <div>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <Icon className="size-5 text-primary" aria-hidden />
        {title}
      </h2>
      <ul className="mt-4 flex flex-col gap-1">
        {days.map((d) => (
          <li key={d.day}>
            <Link
              href={issuesHref(d.issueDate)}
              className="-mx-3 flex items-center justify-between gap-4 rounded-lg px-3 py-3 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              <span>
                {dayLabel(d.day)} <span className="text-muted-foreground">{weekday(d.day)}</span>
              </span>
              <span className="flex items-center gap-2">
                <span className="font-medium tabular-nums">
                  {fmt(d.energy)} <span className="font-normal text-muted-foreground">МВт·ч</span>
                </span>
                <ChevronRight className="size-4 text-muted-foreground" aria-hidden />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

function ExpertNotes({ o }: { o: Overview }) {
  const missingDays = DAYS_IN_MONTH - o.days.length;
  const modelNames = o.models.map((m) => MODEL_LABEL[m] ?? m).join(", ");
  return (
    <details className="group border-t border-border/70 pt-8">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform duration-150 group-open:rotate-90" aria-hidden />
        Подробнее для экспертов
      </summary>
      <ul className="mt-5 flex max-w-2xl list-disc flex-col gap-2 pl-5 text-sm leading-relaxed text-muted-foreground">
        <li>Это прогноз, а не замер. Для каждого дня взят выпуск в 00:00 с уточнением в 12:00.</li>
        <li>Штиль — часы, когда станция даёт меньше {mw(CALM, 2)} ({fmt(CALM * 100)} % мощности).</li>
        <li>Прогноз погоды считается вышедшим через 7 часов после старта расчёта; агент берёт только вышедшие.</li>
        <li className="list-none -ml-5">
          {o.fallbacks.length === 0 ? (
            <span className="flex items-start gap-2">
              <CircleCheck className="mt-0.5 size-4 shrink-0 text-[var(--ok)]" aria-hidden />
              Во всех {o.total} выпусках работала основная модель: {modelNames}.
            </span>
          ) : (
            <span className="flex items-start gap-2">
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[var(--warn)]" aria-hidden />
              <span>
                Запасная модель:{" "}
                {o.fallbacks.map((f, i) => (
                  <span key={f.issueDate}>
                    {i > 0 && ", "}
                    <Link href={issuesHref(f.issueDate)} className="text-primary underline-offset-2 hover:underline">
                      {dayLabel(f.issueDate)}
                    </Link>{" "}
                    ({MODEL_LABEL[f.model] ?? f.model})
                  </span>
                ))}
                .
              </span>
            </span>
          )}
        </li>
        {missingDays > 0 && <li>Нет прогноза на {missingDays} дн. месяца.</li>}
      </ul>
    </details>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true" aria-label="Загружаем прогноз за февраль">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <Skeleton className="h-24 rounded-2xl" />
      <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="h-[34rem] rounded-xl" />
    </div>
  );
}

// ---- page -----------------------------------------------------------------------------------

function OverviewBody() {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const issues = await api.issues();
        const forecasts = await Promise.all(issues.map((i) => api.forecast(i.issue_date)));
        if (alive) setLoad({ state: "ready", data: buildOverview(issues, forecasts) });
      } catch (e) {
        if (alive) setLoad({ state: "error", message: errorText(e) });
      }
    })();
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    setLoad({ state: "loading" });
    setAttempt((a) => a + 1);
  };

  if (load.state === "loading") return <OverviewSkeleton />;

  if (load.state === "error") {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} lead={LEAD} />
        <Alert variant="destructive" className="max-w-2xl">
          <CircleAlert aria-hidden />
          <AlertTitle>Нет данных: {load.message}</AlertTitle>
          <AlertDescription>
            <p>
              Запустите сервис:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
                uv run uvicorn app.main:app --port 8000
              </code>
            </p>
          </AlertDescription>
        </Alert>
        <div>
          <Button variant="outline" onClick={retry}>
            <RefreshCw aria-hidden />
            Повторить
          </Button>
        </div>
      </div>
    );
  }

  const o = load.data;

  if (o.days.length === 0) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} lead={LEAD} />
        <Alert className="max-w-2xl">
          <CircleAlert aria-hidden />
          <AlertTitle>Прогнозов за февраль пока нет</AlertTitle>
          <AlertDescription>
            Запустите агента в разделе <Link href="/agent">«Агент»</Link>.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const byEnergy = o.days.filter((d) => d.hours === 24).sort((a, b) => b.energy - a.energy);
  const windy = byEnergy.slice(0, 3);
  const calm = byEnergy.slice(-3).reverse();

  return (
    <div className="flex flex-col">
      <PageHeader title={TITLE} lead={LEAD} />
      <HowItWorks />

      <Section className="border-t-0 pt-12">
        <StatRow>
          <Stat label="Энергия за месяц" value={fmt(o.energy)} unit="МВт·ч" tone="accent" />
          <Stat label="Средняя мощность" value={fmt(o.mean * RATED_MW, 1)} unit="МВт" />
          <Stat label="Часы штиля" value={fmt(o.calmHours)} unit="ч" />
          <Stat label="Уточнений в 12:00" value={fmt(o.recomputed)} unit={`из ${o.total}`} />
        </StatRow>
      </Section>

      <Section
        title="Каждый час февраля"
        help={
          <ul className="flex flex-col gap-2">
            <li>Строка — день, клетка — час по Алматы.</li>
            <li>Чем темнее клетка, тем больше ветра и энергии.</li>
            <li>Нажмите на день, чтобы открыть его прогноз.</li>
          </ul>
        }
      >
        <Card>
          <CardContent className="py-2">
            <Heatmap
              cells={o.cells}
              onPick={(day) => {
                const issueDate = o.issueByDay.get(day);
                if (issueDate) router.push(issuesHref(issueDate));
              }}
            />
          </CardContent>
        </Card>
      </Section>

      <Section>
        <div className="grid gap-10 sm:grid-cols-2 sm:gap-16">
          <DayList title="Самые ветреные дни" icon={Wind} days={windy} />
          <DayList title="Самые тихие дни" icon={WindArrowDown} days={calm} />
        </div>
      </Section>

      <ExpertNotes o={o} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<OverviewSkeleton />}>
      <OverviewBody />
    </Suspense>
  );
}

"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CirclePause,
  Gauge,
  LifeBuoy,
  type LucideIcon,
  RefreshCw,
  TriangleAlert,
  Wind,
  WindArrowDown,
  Zap,
} from "lucide-react";
import { Heatmap, type HeatCell } from "@/components/charts";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  ApiError,
  type ForecastIssue,
  type ForecastRow,
  type IssueListItem,
  MODEL_LABEL,
  RATED_MW,
  STATION,
  TOOL_LABEL,
  api,
  dayLabel,
  localDay,
  localHour,
  mw,
  planRows,
} from "@/lib/api";
import { cn } from "@/lib/utils";

const MONTH = "2026-02";
// Below 5 % of rated power the turbines are practically standing: counted as calm.
const CALM = 0.05;
const DAY_MAX_MWH = RATED_MW * 24;
const DAYS_IN_MONTH = new Date(Date.UTC(2026, 2, 0)).getUTCDate();

const STEPS: { tool: string; hint: string }[] = [
  { tool: "plan", hint: "решает, какие шаги нужны для выпуска" },
  { tool: "fetch_weather", hint: "берёт архивные прогоны погоды по координатам ВЭС" },
  { tool: "validate_weather", hint: "проверяет полноту, диапазоны и время публикации прогона" },
  { tool: "prepare", hint: "собирает входные данные на 48 часов" },
  { tool: "run_model", hint: "считает мощность и коридор p10–p90" },
  { tool: "analyze", hint: "ищет риски: резкие изменения, штиль, холод" },
  { tool: "recompute_if_updated", hint: "обновляет часы, если вышел более свежий прогон" },
  { tool: "reflect", hint: "сверяет прошлые выпуски с пришедшим фактом" },
  { tool: "write_report", hint: "пишет сводку для диспетчера" },
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
  mean: number; // share of rated
  peak: ForecastRow;
  calmHours: number;
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
    .map(([day, list]) => {
      const sum = list.reduce((s, v) => s + v.row.power_farm, 0);
      const peak = list.reduce((p, v) => (v.row.power_farm > p.power_farm ? v.row : p), list[0].row);
      return {
        day,
        issueDate: issueByDay.get(day) ?? list[0].issueDate,
        energy: sum * RATED_MW,
        hours: list.length,
        mean: sum / list.length,
        peak,
        calmHours: list.filter((v) => v.row.power_farm < CALM).length,
      };
    });

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
  if (e instanceof ApiError) return `Сервис прогноза ответил ошибкой ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : "Неизвестная ошибка при загрузке выпусков.";
}

// ---- pieces ---------------------------------------------------------------------------------

function Tile({ icon: Icon, label, value, unit, children, className }: {
  icon: LucideIcon;
  label: string;
  value: string;
  unit?: string;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <Card size="sm" className={className}>
      <CardContent className="flex h-full flex-col">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="size-4 shrink-0" aria-hidden />
          <span className="leading-snug">{label}</span>
        </div>
        <div className="mt-2 text-xl font-semibold tracking-tight tabular-nums sm:text-2xl">
          {value}
          {unit && <span className="ml-1 text-sm font-normal text-muted-foreground sm:text-base">{unit}</span>}
        </div>
        <div className="mt-1 text-xs leading-relaxed text-muted-foreground">{children}</div>
      </CardContent>
    </Card>
  );
}

function DayItem({ d, kind }: { d: DayPlan; kind: "windy" | "calm" }) {
  return (
    <li>
      <Link
        href={issuesHref(d.issueDate)}
        className="-mx-2 block rounded-lg px-2 py-2 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <div className="flex items-baseline justify-between gap-3">
          <span className="font-medium">
            {dayLabel(d.day)} <span className="font-normal text-muted-foreground">{weekday(d.day)}</span>
          </span>
          <span className="font-medium tabular-nums">{fmt(d.energy)} МВт·ч</span>
        </div>
        <div className="mt-1.5 h-1.5 rounded-full bg-muted" aria-hidden>
          <div
            className="h-full rounded-full bg-primary"
            style={{ width: `${Math.max(2, Math.min(100, (d.energy / DAY_MAX_MWH) * 100))}%` }}
          />
        </div>
        <div className="mt-1 flex items-center justify-between gap-2 text-xs text-muted-foreground">
          <span>
            средняя {fmt(d.mean * 100)} %
            {kind === "windy"
              ? ` · пик ${fmt(d.peak.power_farm * 100)} % в ${String(localHour(d.peak.target_time_local)).padStart(2, "0")}:00`
              : ` · штиль ${d.calmHours} ч`}
          </span>
          <span className="flex shrink-0 items-center gap-0.5 text-primary">
            выпуск
            <ChevronRight className="size-3.5" aria-hidden />
          </span>
        </div>
      </Link>
    </li>
  );
}

function ExtremeDays({ days }: { days: DayPlan[] }) {
  const full = days.filter((d) => d.hours === 24);
  const byEnergy = [...full].sort((a, b) => b.energy - a.energy);
  const windy = byEnergy.slice(0, 3);
  const calm = byEnergy.slice(-3).reverse();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Самые ветреные и самые тихие сутки</CardTitle>
        <CardDescription>
          Энергия за сутки по плану. Полоса — доля от максимума {fmt(DAY_MAX_MWH)} МВт·ч, если бы ВЭС весь день
          работала на номинале.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2 xl:grid-cols-1">
        <section aria-labelledby="windy-days">
          <h3 id="windy-days" className="flex items-center gap-2 text-sm font-medium">
            <Wind className="size-4 text-primary" aria-hidden />
            Больше всего энергии
          </h3>
          <ul className="mt-1">
            {windy.map((d) => <DayItem key={d.day} d={d} kind="windy" />)}
          </ul>
        </section>
        <section aria-labelledby="calm-days">
          <h3 id="calm-days" className="flex items-center gap-2 text-sm font-medium">
            <WindArrowDown className="size-4 text-muted-foreground" aria-hidden />
            Меньше всего энергии
          </h3>
          <ul className="mt-1">
            {calm.map((d) => <DayItem key={d.day} d={d} kind="calm" />)}
          </ul>
        </section>
      </CardContent>
    </Card>
  );
}

function AgentSteps() {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Что агент делает каждую ночь</CardTitle>
        <CardDescription>
          {STEPS.length} шагов одного выпуска. Решения и причины по каждому шагу — в журнале агента.
        </CardDescription>
        <CardAction>
          <Link href="/agent" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Открыть журнал
            <ChevronRight aria-hidden />
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-1 sm:grid-cols-2 lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.tool}>
              <Link
                href="/agent"
                className="-mx-2 flex items-start gap-3 rounded-lg px-2 py-2 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-md bg-accent text-xs font-medium text-accent-foreground tabular-nums">
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium leading-snug">{TOOL_LABEL[s.tool] ?? s.tool}</span>
                  <span className="block text-xs leading-snug text-muted-foreground">{s.hint}</span>
                </span>
              </Link>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

function OverviewSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Загружаем выпуски за февраль">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-full max-w-xl" />
        <Skeleton className="h-4 w-full max-w-2xl" />
      </div>
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className={cn("h-28 rounded-xl", i === 4 && "col-span-2 xl:col-span-1")} />
        ))}
      </div>
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <Skeleton className="h-[30rem] rounded-xl" />
        <Skeleton className="h-[30rem] rounded-xl" />
      </div>
      <Skeleton className="h-44 rounded-xl" />
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

  const intro = (
    <div className="flex flex-col gap-1.5">
      <h1 className="text-2xl font-semibold tracking-tight text-balance">
        Февраль 2026: ожидаемая выработка {STATION}
      </h1>
      <p className="max-w-3xl text-muted-foreground text-pretty">
        Каждые сутки в 00:00 по Алматы агент выпускает прогноз на 48 часов и берёт только те прогнозы погоды,
        которые были опубликованы до этого момента.
      </p>
    </div>
  );

  if (load.state === "loading") return <OverviewSkeleton />;

  if (load.state === "error") {
    return (
      <div className="flex flex-col gap-6">
        {intro}
        <Alert variant="destructive">
          <CircleAlert aria-hidden />
          <AlertTitle>Не удалось загрузить выпуски за февраль</AlertTitle>
          <AlertDescription>
            <p>{load.message}</p>
            <p>
              Запустите сервис прогноза в папке проекта:{" "}
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
        {intro}
        <Alert>
          <CircleAlert aria-hidden />
          <AlertTitle>Выпусков за февраль пока нет</AlertTitle>
          <AlertDescription>
            Агент ещё не публиковал прогнозы на этот месяц. Запустите выпуск в разделе{" "}
            <Link href="/agent">«Агент»</Link>.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const missingDays = DAYS_IN_MONTH - o.days.length;
  const modelNames = o.models.map((m) => MODEL_LABEL[m] ?? m).join(", ");

  return (
    <div className="wc-enter flex flex-col gap-6">
      {intro}

      <section aria-label="Итоги месяца" className="grid grid-cols-2 gap-3 xl:grid-cols-5">
        <Tile icon={Zap} label="Энергия за февраль" value={fmt(o.energy)} unit="МВт·ч">
          сумма плана за {fmt(o.hours)} ч, {o.days.length} сут.
          {missingDays > 0 && `; нет плана на ${missingDays} сут.`}
        </Tile>
        <Tile icon={Gauge} label="Средняя выработка" value={fmt(o.mean * 100)} unit="% номинала">
          в среднем {mw(o.mean)} из {fmt(RATED_MW)} МВт
        </Tile>
        <Tile icon={CirclePause} label="Часы штиля" value={fmt(o.calmHours)} unit="ч">
          {fmt(o.hours ? (o.calmHours / o.hours) * 100 : 0)} % часов месяца, выработка ниже{" "}
          {fmt(CALM * 100)} % номинала ({mw(CALM, 2)})
        </Tile>
        <Tile
          icon={RefreshCw}
          label="Пересчётов по свежему прогону"
          value={`${o.recomputed} из ${o.total}`}
        >
          выпусков, где агент обновил план после выхода более свежего прогона погоды
        </Tile>
        <Tile
          icon={LifeBuoy}
          label="Выпусков с запасной моделью"
          value={`${o.fallbacks.length} из ${o.total}`}
          className="col-span-2 xl:col-span-1"
        >
          {o.fallbacks.length === 0 ? (
            <span className="flex items-start gap-1.5">
              <CircleCheck className="mt-0.5 size-3.5 shrink-0 text-[var(--ok)]" aria-hidden />
              везде работала основная модель: {modelNames}
            </span>
          ) : (
            <span className="flex items-start gap-1.5">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-[var(--warn)]" aria-hidden />
              <span>
                запасная модель в выпусках:{" "}
                {o.fallbacks.map((f, i) => (
                  <span key={f.issueDate}>
                    {i > 0 && ", "}
                    <Link href={issuesHref(f.issueDate)} className="text-primary underline-offset-2 hover:underline">
                      {dayLabel(f.issueDate)}
                    </Link>{" "}
                    ({MODEL_LABEL[f.model] ?? f.model})
                  </span>
                ))}
              </span>
            </span>
          )}
        </Tile>
      </section>

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_18rem]">
        <Card>
          <CardHeader>
            <CardTitle>Выработка по часам</CardTitle>
            <CardDescription>
              Строка — сутки, клетка — час по Алматы. Для каждых суток взят план из выпуска, сделанного в 00:00 этих
              суток, с учётом дневного пересчёта. Это прогноз, а не замер выработки.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Heatmap
              cells={o.cells}
              onPick={(day) => {
                const issueDate = o.issueByDay.get(day);
                if (issueDate) router.push(issuesHref(issueDate));
              }}
            />
          </CardContent>
        </Card>
        <ExtremeDays days={o.days} />
      </div>

      <AgentSteps />

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

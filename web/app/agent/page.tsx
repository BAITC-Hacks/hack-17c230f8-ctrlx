"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import {
  Calculator,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  ClipboardList,
  CloudSun,
  FileBraces,
  FileText,
  GitBranch,
  MessageSquareText,
  RefreshCw,
  ScanSearch,
  SearchX,
  ServerCrash,
  ShieldCheck,
  SlidersHorizontal,
  Timer,
  TriangleAlert,
  Undo2,
  Wind,
  type LucideIcon,
} from "lucide-react";
import {
  ApiError,
  MODEL_LABEL,
  TOOL_LABEL,
  WX_FIELD_LABEL,
  api,
  dayLabel,
  type AgentStep,
  type ForecastIssue,
  type IssueListItem,
  type WxField,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Explain, PageHeader, Section, Stat, StatRow } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

// ---- status -----------------------------------------------------------------------------------

type Status = AgentStep["status"];
type FlowStatus = Status | "skipped";

const STATUS: Record<FlowStatus, { text: string; icon: LucideIcon; tone: string }> = {
  ok: { text: "готово", icon: CircleCheck, tone: "text-[color:var(--ok)]" },
  warn: { text: "внимание", icon: TriangleAlert, tone: "text-[color:var(--warn)]" },
  fail: { text: "сбой", icon: CircleX, tone: "text-destructive" },
  skipped: { text: "пропущен", icon: CircleDashed, tone: "text-muted-foreground" },
};

const RANK: Record<Status, number> = { ok: 0, warn: 1, fail: 2 };

function StatusLine({ status, className }: { status: FlowStatus; className?: string }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Icon className={cn("size-4 shrink-0", s.tone)} aria-hidden />
      {s.text}
    </span>
  );
}

// ---- steps in plain words ------------------------------------------------------------------------

const TOOL_META: Record<string, { name: string; plain: string; icon: LucideIcon }> = {
  plan: { name: "План", plain: "Решает, на какие сутки прогноз и какие данные уже известны.", icon: ClipboardList },
  fetch_weather: { name: "Погода", plain: "Берёт прогноз погоды, доступный на момент выпуска.", icon: CloudSun },
  validate_weather: {
    name: "Проверка погоды",
    plain: "Проверяет, что погода есть на все 48 часов и не взята из будущего.",
    icon: ShieldCheck,
  },
  prepare: { name: "Подготовка", plain: "Готовит ветер, порывы и время суток для модели.", icon: SlidersHorizontal },
  run_model: { name: "Прогноз", plain: "Считает выработку станции на каждый час.", icon: Wind },
  analyze: { name: "Контроль", plain: "Проверяет прогноз на ошибки перед публикацией.", icon: ScanSearch },
  recompute_if_updated: { name: "Уточнение в 12:00", plain: "Уточняет прогноз по свежей погоде.", icon: RefreshCw },
  reflect: { name: "Сверка", plain: "Сравнивает прошлые прогнозы с фактом.", icon: Undo2 },
  write_report: { name: "Отчёт", plain: "Сохраняет прогноз, заявку и сводку.", icon: FileText },
};

const metaOf = (tool: string) =>
  TOOL_META[tool] ?? { name: TOOL_LABEL[tool] ?? tool, plain: "", icon: CircleDashed };

const DECISION_LABEL: Record<string, string> = {
  facts_frozen: "прогноз только по погоде",
  facts_complete: "факт учтён",
  cache: "погода из архива",
  live_match: "свежий запрос совпал с архивом",
  live_mismatch: "свежий запрос расходится с архивом",
  proceed: "данные в порядке, продолжить",
  older_run: "взять прогноз погоды постарше",
  climatology: "средняя погода по сезону",
  accept: "прогноз принят",
  reject: "не публиковать",
  keep_revision_0: "оставить утренний прогноз",
  no_update: "уточнять нечего",
  frozen: "без поправки",
  ok: "поправка не нужна",
  no_facts: "сверять пока не с чем",
  llm: "сводку написал ИИ",
  llm_rejected: "текст ИИ отклонён, сводка по шаблону",
  template: "сводка по шаблону",
};

// Decisions the agent takes on every normal night; anything else is worth opening first.
const ROUTINE = new Set([
  "facts_frozen",
  "facts_complete",
  "cache",
  "live_match",
  "proceed",
  "accept",
  "no_update",
  "frozen",
  "ok",
  "no_facts",
  "llm",
  "template",
  "recompute (без существенных изменений)",
]);

const MODEL_NAME: Record<string, string> = { ...MODEL_LABEL, gfs_power_curve: "кривая мощности по GFS" };

function decisionLabel(code: string): string {
  if (code in DECISION_LABEL) return DECISION_LABEL[code];
  const arrow = /^(fallback|switch) → (.+)$/.exec(code);
  if (arrow) {
    return arrow[1] === "fallback"
      ? `запасная модель: ${MODEL_NAME[arrow[2]] ?? arrow[2]}`
      : `другой источник погоды: ${arrow[2]}`;
  }
  if (code.startsWith("recompute")) return code.replace(/^recompute/, "уточнить прогноз");
  if (code.startsWith("drift:")) return code.replace(/^drift:/, "сдвиг:");
  return code;
}

const notable = (s: AgentStep) => s.status !== "ok" || (s.decision !== null && !ROUTINE.has(s.decision));

// ---- formatting ---------------------------------------------------------------------------------

const intFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const oneFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

const ms = (value: number) => (value < 1 ? "меньше 1 мс" : `${intFmt.format(value)} мс`);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---- validate_weather args (expert details only) --------------------------------------------------

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isWxField = (k: string): k is WxField => k in WX_FIELD_LABEL;

const FIELD_ORDER: WxField[] = ["day1", "day2", "day3", "none"];
const FIELD_TONE: Record<WxField, string> = {
  day1: "bg-primary",
  day2: "bg-[color:var(--chart-2)]",
  day3: "bg-[color:var(--chart-4)]",
  none: "bg-[color:var(--chart-3)]",
};

interface WeatherArgs {
  covered: number;
  hours: number;
  fields: { key: WxField; hours: number }[];
  source: string | null;
}

function readWeatherArgs(args: Record<string, unknown>): WeatherArgs | null {
  const { covered, hours, fields, source } = args;
  if (typeof covered !== "number" || typeof hours !== "number" || hours <= 0) return null;
  const parsed: WeatherArgs["fields"] = [];
  if (isRecord(fields)) {
    for (const [key, n] of Object.entries(fields)) {
      if (isWxField(key) && typeof n === "number" && n > 0) parsed.push({ key, hours: n });
    }
  }
  parsed.sort((a, b) => FIELD_ORDER.indexOf(a.key) - FIELD_ORDER.indexOf(b.key));
  return { covered, hours, fields: parsed, source: typeof source === "string" && source ? source : null };
}

function WeatherBar({ w }: { w: WeatherArgs }) {
  if (w.fields.length === 0) return null;
  return (
    <div className="mt-2">
      <div
        className="flex h-2 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`Часы по свежести прогноза погоды: ${w.fields
          .map((f) => `${WX_FIELD_LABEL[f.key]} — ${f.hours} ч`)
          .join(", ")}`}
      >
        {w.fields.map((f) => (
          <span
            key={f.key}
            className={cn("h-full border-r-2 border-card last:border-r-0", FIELD_TONE[f.key])}
            style={{ width: `${(f.hours / w.hours) * 100}%` }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {w.fields.map((f) => (
          <li key={f.key} className="inline-flex items-center gap-1.5">
            <span aria-hidden className={cn("size-2 rounded-sm", FIELD_TONE[f.key])} />
            {WX_FIELD_LABEL[f.key]} — {f.hours} ч
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---- flow of the 9 steps -------------------------------------------------------------------------

interface FlowItem {
  tool: string;
  steps: AgentStep[];
  status: FlowStatus;
}

function buildFlow(log: AgentStep[]): FlowItem[] {
  const tools = [...Object.keys(TOOL_LABEL)];
  for (const s of log) if (!tools.includes(s.tool)) tools.push(s.tool);
  return tools.map((tool) => {
    const steps = log.filter((s) => s.tool === tool);
    const status: FlowStatus = steps.length
      ? steps.reduce<Status>((worst, s) => ((RANK[s.status] ?? 1) > RANK[worst] ? s.status : worst), "ok")
      : "skipped";
    return { tool, steps, status };
  });
}

const keyStep = (item: FlowItem): AgentStep | undefined => item.steps.find(notable) ?? item.steps.at(-1);

function FlowStrip({
  flow,
  selected,
  onSelect,
}: {
  flow: FlowItem[];
  selected: string;
  onSelect: (tool: string) => void;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);

  // On narrow screens the strip scrolls; keep the chosen step in view.
  useEffect(() => {
    const box = scroller.current;
    const el = tabs.current[flow.findIndex((f) => f.tool === selected)];
    if (!box || !el || box.scrollWidth <= box.clientWidth) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    box.scrollTo({
      left: el.offsetLeft - box.clientWidth / 2 + el.offsetWidth / 2,
      behavior: reduce ? "auto" : "smooth",
    });
  }, [flow, selected]);

  const onKeyDown = (e: KeyboardEvent<HTMLOListElement>) => {
    const i = flow.findIndex((f) => f.tool === selected);
    const next =
      e.key === "ArrowRight" ? i + 1 : e.key === "ArrowLeft" ? i - 1 : e.key === "Home" ? 0 : e.key === "End" ? flow.length - 1 : null;
    if (next === null || next < 0 || next >= flow.length) return;
    e.preventDefault();
    onSelect(flow[next].tool);
    tabs.current[next]?.focus();
  };

  return (
    <div ref={scroller} className="-mx-5 overflow-x-auto px-5 pb-2 [scrollbar-width:none] sm:-mx-8 sm:px-8">
      <ol
        role="tablist"
        aria-label="Шаги агента"
        onKeyDown={onKeyDown}
        className="grid"
        style={{ gridTemplateColumns: `repeat(${flow.length}, minmax(0, 1fr))`, minWidth: `${flow.length * 5.75}rem` }}
      >
        {flow.map((item, i) => {
          const meta = metaOf(item.tool);
          const Icon = meta.icon;
          const active = item.tool === selected;
          return (
            <li key={item.tool} role="presentation" className="relative min-w-0">
              {i < flow.length - 1 && (
                <span aria-hidden className="absolute top-6 left-1/2 h-px w-full bg-border" />
              )}
              <button
                ref={(el) => {
                  tabs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`agent-tab-${item.tool}`}
                aria-selected={active}
                aria-controls="agent-step-panel"
                tabIndex={active ? 0 : -1}
                onClick={() => onSelect(item.tool)}
                className="group flex w-full flex-col items-center gap-3 rounded-xl px-1 pb-1 text-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <span
                  className={cn(
                    "relative z-10 flex size-12 items-center justify-center rounded-full transition-[background-color,box-shadow,transform] duration-150 ease-[var(--ease-out-strong)] group-active:scale-95",
                    active
                      ? "bg-primary text-primary-foreground ring-4 ring-primary/15"
                      : "bg-card text-foreground/75 ring-1 ring-border group-hover:ring-foreground/30",
                    !active && item.status === "warn" && "ring-2 ring-[color:var(--warn)]",
                    !active && item.status === "fail" && "ring-2 ring-destructive",
                    item.status === "skipped" && "opacity-60",
                  )}
                >
                  <Icon className="size-5" aria-hidden />
                </span>
                <span className={cn("text-sm leading-snug text-balance", active ? "font-semibold" : "font-medium")}>
                  {meta.name}
                </span>
                <StatusLine status={item.status} className="text-xs text-muted-foreground" />
                <span
                  aria-hidden
                  className={cn("h-0.5 w-8 rounded-full transition-colors duration-150", active ? "bg-primary" : "bg-transparent")}
                />
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

// ---- detail of the selected step ----------------------------------------------------------------

function ExpertDetails({ step, runs }: { step: AgentStep; runs: number }) {
  const weather = step.tool === "validate_weather" ? readWeatherArgs(step.args) : null;
  const rows: { term: string; value: ReactNode }[] = [
    ...(step.decision ? [{ term: "Запись в журнале", value: step.summary }] : []),
    ...(weather
      ? [
          {
            term: "Покрытие погодой",
            value: (
              <>
                {weather.covered} из {weather.hours} ч{weather.source ? `, источник ${weather.source}` : ""}
                <WeatherBar w={weather} />
              </>
            ),
          },
        ]
      : []),
    ...(step.llm
      ? [{ term: "ИИ", value: `${step.llm.provider} ${step.llm.model}, ${intFmt.format(step.llm.tokens)} токенов` }]
      : []),
    ...(runs > 1 ? [{ term: "Запусков", value: String(runs) }] : []),
    { term: "Код шага", value: <code className="font-mono text-xs">{step.tool}</code> },
    ...(step.decision && decisionLabel(step.decision) !== step.decision
      ? [{ term: "Код решения", value: <code className="font-mono text-xs">{step.decision}</code> }]
      : []),
    { term: "Прогон", value: <code className="font-mono text-xs break-all">{step.run_id}</code> },
  ];
  return (
    <details className="group/x md:col-span-2">
      <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform duration-150 group-open/x:rotate-90" aria-hidden />
        Подробнее для экспертов
      </summary>
      <dl className="mt-4 grid gap-x-6 gap-y-3 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
        {rows.map((r) => (
          <div key={r.term} className="contents">
            <dt className="text-muted-foreground">{r.term}</dt>
            <dd className="min-w-0 text-pretty">{r.value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}

function StepDetail({ item, index, total }: { item: FlowItem; index: number; total: number }) {
  const meta = metaOf(item.tool);
  const step = keyStep(item);
  return (
    <div
      id="agent-step-panel"
      role="tabpanel"
      aria-labelledby={`agent-tab-${item.tool}`}
      className="wc-enter grid gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-x-12"
    >
      <div>
        <p className="text-sm text-muted-foreground">
          Шаг {index + 1} из {total}
        </p>
        <h2 className="mt-1 text-2xl font-semibold tracking-tight">{meta.name}</h2>
        {meta.plain && <p className="mt-3 text-base text-muted-foreground">{meta.plain}</p>}
        <div className="mt-5 flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <StatusLine status={item.status} />
          {step && (
            <span className="inline-flex items-center gap-1.5 text-muted-foreground">
              <Timer className="size-4" aria-hidden />
              {ms(step.duration_ms)}
            </span>
          )}
        </div>
      </div>

      {step ? (
        <dl className="flex flex-col gap-6">
          <div>
            <dt className="text-sm text-muted-foreground">{step.decision ? "Решение" : "Итог"}</dt>
            <dd className="mt-1 text-lg font-medium text-pretty">
              {cap(step.decision ? decisionLabel(step.decision) : step.summary)}
            </dd>
          </div>
          {step.decision && step.reason && (
            <div>
              <dt className="text-sm text-muted-foreground">Почему</dt>
              <dd className="mt-1 text-base text-pretty">{cap(step.reason)}</dd>
            </div>
          )}
        </dl>
      ) : (
        <p className="text-base text-muted-foreground">В этом выпуске шаг не запускался.</p>
      )}

      {step && <ExpertDetails step={step} runs={item.steps.length} />}
    </div>
  );
}

// ---- how it works ----------------------------------------------------------------------------------

const PRINCIPLES: { icon: LucideIcon; text: string }[] = [
  { icon: Calculator, text: "Все числа считают проверенные модели, не ИИ." },
  { icon: GitBranch, text: "Если данные плохие — агент берёт запасной путь и пишет почему." },
  { icon: RefreshCw, text: "В 12:00 уточняет прогноз по свежей погоде." },
  { icon: MessageSquareText, text: "ИИ только объясняет итог простыми словами." },
];

function HowItWorks() {
  return (
    <Explain label="Как устроен агент">
      <ul className="flex flex-col gap-3">
        {PRINCIPLES.map(({ icon: Icon, text }) => (
          <li key={text} className="flex gap-2.5">
            <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </Explain>
  );
}

// ---- loaded screen -----------------------------------------------------------------------------------

function AgentRun({ issue, log }: { issue: ForecastIssue; log: AgentStep[] }) {
  const flow = useMemo(() => buildFlow(log), [log]);
  const fallback = (flow.find((f) => f.steps.some(notable)) ?? flow[0]).tool;
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked && flow.some((f) => f.tool === picked) ? picked : fallback;
  const index = flow.findIndex((f) => f.tool === selected);

  const clean = log.filter((s) => s.status === "ok").length;
  const decisions = log.filter((s) => s.decision !== null).length;
  const total = log.reduce((sum, s) => sum + s.duration_ms, 0);

  return (
    <>
      <Section>
        <StatRow>
          <Stat label="Шагов без замечаний" value={clean} unit={`из ${log.length}`} />
          <Stat label="Решений принято" value={decisions} />
          <Stat
            label="Время работы"
            value={total >= 1000 ? oneFmt.format(total / 1000) : intFmt.format(total)}
            unit={total >= 1000 ? "с" : "мс"}
          />
          <Stat label="Запасной путь" value={issue.fallback_used ? "включён" : "не нужен"} />
        </StatRow>
        {issue.warnings.length > 0 && (
          <Alert className="mt-8">
            <TriangleAlert className="text-[color:var(--warn)]" />
            <AlertTitle>Предупреждения</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {issue.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}
      </Section>

      <Section className="border-t-0 pt-0">
        {log.length === 0 ? (
          <p className="text-base text-muted-foreground">Для этого выпуска журнал пуст.</p>
        ) : (
          <Card className="gap-0 py-0 text-base">
            <div className="px-5 pt-8 pb-6 sm:px-8">
              <FlowStrip flow={flow} selected={selected} onSelect={setPicked} />
            </div>
            <div className="border-t px-5 py-8 sm:px-8 sm:py-10">
              <StepDetail key={selected} item={flow[index]} index={index} total={flow.length} />
            </div>
          </Card>
        )}
        <div className="mt-6 flex flex-wrap items-center justify-between gap-4">
          <HowItWorks />
          <a
            href={`/api/runs/${encodeURIComponent(issue.run_id)}/log`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1.5 rounded-md text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            <FileBraces className="size-4" aria-hidden />
            Журнал целиком (JSON)
          </a>
        </div>
      </Section>
    </>
  );
}

// ---- states ------------------------------------------------------------------------------------

interface LoadError {
  status: number;
  message: string;
}

const toLoadError = (e: unknown): LoadError =>
  e instanceof ApiError
    ? { status: e.status, message: e.message }
    : { status: -1, message: e instanceof Error ? e.message : String(e) };

function ErrorAlert({ error }: { error: LoadError }) {
  if (error.status === 404) {
    return (
      <Alert>
        <SearchX />
        <AlertTitle>Выпуск не найден</AlertTitle>
        <AlertDescription>Выберите другую дату.</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <ServerCrash />
      <AlertTitle>Нет связи с сервисом прогноза</AlertTitle>
      <AlertDescription>
        <p>
          {error.status > 0 ? `Ответ ${error.status}. ` : ""}Запустите API из корня проекта и обновите страницу:
        </p>
        <code className="mt-1 block w-fit rounded bg-muted px-2 py-1 font-mono text-xs text-foreground">
          uv run uvicorn app.main:app --port 8000
        </code>
      </AlertDescription>
    </Alert>
  );
}

function LoadingState() {
  return (
    <div aria-busy="true" aria-label="Загрузка журнала агента">
      <div className="grid grid-cols-2 gap-8 pt-2 pb-10 lg:grid-cols-4">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i}>
            <Skeleton className="h-4 w-28" />
            <Skeleton className="mt-3 h-10 w-20" />
          </div>
        ))}
      </div>
      <div className="rounded-xl p-8 ring-1 ring-foreground/10">
        <div className="flex justify-between gap-4 overflow-hidden">
          {Array.from({ length: 9 }, (_, i) => (
            <Skeleton key={i} className="size-12 shrink-0 rounded-full" />
          ))}
        </div>
        <Skeleton className="mt-12 h-7 w-48" />
        <Skeleton className="mt-4 h-5 w-full max-w-md" />
        <Skeleton className="mt-8 h-16 w-full" />
      </div>
    </div>
  );
}

// ---- picker ------------------------------------------------------------------------------------

function IssuePicker({
  issues,
  value,
  onChange,
}: {
  issues: IssueListItem[];
  value: string;
  onChange: (date: string) => void;
}) {
  const dates = issues.map((i) => i.issue_date);
  const idx = dates.indexOf(value);
  const items = dates.map((d) => ({ value: d, label: dayLabel(d) }));
  return (
    <div className="flex items-center gap-1.5">
      <Button
        variant="outline"
        size="icon"
        aria-label="Предыдущий выпуск"
        disabled={idx <= 0}
        onClick={() => onChange(dates[idx - 1])}
      >
        <ChevronLeft />
      </Button>
      <Select
        items={items}
        value={idx >= 0 ? value : null}
        onValueChange={(v) => {
          if (typeof v === "string") onChange(v);
        }}
      >
        <SelectTrigger className="w-40" aria-label="Выпуск за дату">
          <SelectValue placeholder="Выпуск" />
        </SelectTrigger>
        <SelectContent>
          {items.map((it) => (
            <SelectItem key={it.value} value={it.value}>
              {it.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button
        variant="outline"
        size="icon"
        aria-label="Следующий выпуск"
        disabled={idx < 0 || idx >= dates.length - 1}
        onClick={() => onChange(dates[idx + 1])}
      >
        <ChevronRight />
      </Button>
    </div>
  );
}

// ---- page --------------------------------------------------------------------------------------

interface Loaded {
  date: string;
  issue: ForecastIssue | null;
  log: AgentStep[];
  error: LoadError | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function AgentScreen() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [issuesError, setIssuesError] = useState<LoadError | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .issues()
      .then((list) => {
        if (alive) setIssues([...list].sort((a, b) => a.issue_date.localeCompare(b.issue_date)));
      })
      .catch((e: unknown) => {
        if (alive) setIssuesError(toLoadError(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  const param = params.get("date");
  const date = param && DATE_RE.test(param) ? param : (issues?.at(-1)?.issue_date ?? null);

  useEffect(() => {
    if (!date) return;
    let alive = true;
    api
      .forecast(date)
      .then(async (issue) => {
        const log = await api.log(issue.run_id);
        if (alive) setLoaded({ date, issue, log: [...log].sort((a, b) => a.step - b.step), error: null });
      })
      .catch((e: unknown) => {
        if (alive) setLoaded({ date, issue: null, log: [], error: toLoadError(e) });
      });
    return () => {
      alive = false;
    };
  }, [date]);

  const choose = (d: string) => router.replace(`${pathname}?date=${d}`, { scroll: false });

  const current = loaded && loaded.date === date ? loaded : null;
  const issue = current?.issue ?? null;

  let body: ReactNode;
  if (!date) {
    if (issuesError) body = <ErrorAlert error={issuesError} />;
    else if (issues && issues.length === 0)
      body = (
        <Alert>
          <CircleDashed />
          <AlertTitle>Выпусков пока нет</AlertTitle>
          <AlertDescription>Журнал появится после первого прогноза.</AlertDescription>
        </Alert>
      );
    else body = <LoadingState />;
  } else if (!current) {
    body = <LoadingState />;
  } else if (current.error || !issue) {
    body = current.error ? <ErrorAlert error={current.error} /> : <LoadingState />;
  } else {
    body = <AgentRun key={current.date} issue={issue} log={current.log} />;
  }

  return (
    <div>
      <PageHeader
        title="Что сделал агент"
        lead="9 шагов за одну ночь — каждое решение с причиной"
        actions={issues && issues.length > 0 && date ? <IssuePicker issues={issues} value={date} onChange={choose} /> : null}
      />
      <div>{body}</div>
    </div>
  );
}

export default function AgentPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96 w-full rounded-xl" />}>
      <AgentScreen />
    </Suspense>
  );
}

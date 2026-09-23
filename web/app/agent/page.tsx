"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  Calculator,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleDashed,
  CircleX,
  FileBraces,
  GitBranch,
  MessageSquareText,
  RefreshCw,
  SearchX,
  ServerCrash,
  Timer,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import {
  ApiError,
  MODEL_LABEL,
  TOOL_LABEL,
  WX_FIELD_LABEL,
  api,
  dayLabel,
  when,
  type AgentStep,
  type ForecastIssue,
  type IssueListItem,
  type WxField,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

// ---- status -----------------------------------------------------------------------------------

type Status = AgentStep["status"];
type FlowStatus = Status | "skipped";

// Amber on white is too faint for small text, so the warning badge keeps dark text and an amber icon.
const STATUS: Record<FlowStatus, { text: string; icon: LucideIcon; icon_tone: string; text_tone: string; soft: string }> = {
  ok: {
    text: "ок",
    icon: CircleCheck,
    icon_tone: "text-[color:var(--ok)]",
    text_tone: "text-[color:var(--ok)]",
    soft: "bg-[color:var(--ok)]/10",
  },
  warn: {
    text: "внимание",
    icon: TriangleAlert,
    icon_tone: "text-[color:var(--warn)]",
    text_tone: "text-foreground",
    soft: "bg-[color:var(--warn)]/15",
  },
  fail: {
    text: "сбой",
    icon: CircleX,
    icon_tone: "text-destructive",
    text_tone: "text-destructive",
    soft: "bg-destructive/10",
  },
  skipped: {
    text: "не запускался",
    icon: CircleDashed,
    icon_tone: "text-muted-foreground",
    text_tone: "text-muted-foreground",
    soft: "bg-muted",
  },
};

const RANK: Record<Status, number> = { ok: 0, warn: 1, fail: 2 };

const statusOf = (s: string) => STATUS[s as FlowStatus] ?? STATUS.warn;

function StatusBadge({ status }: { status: FlowStatus }) {
  const s = statusOf(status);
  const Icon = s.icon;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1 rounded-full px-2 text-xs font-medium",
        s.soft,
        s.text_tone,
      )}
    >
      <Icon className={cn("size-3.5", s.icon_tone)} aria-hidden />
      {s.text}
    </span>
  );
}

// ---- decisions: the log keeps machine codes, the dispatcher reads words ------------------------

const DECISION_LABEL: Record<string, string> = {
  facts_frozen: "прогноз только по погоде",
  facts_complete: "факт учтён",
  cache: "погода из архива",
  live_match: "живой запрос совпал с архивом",
  live_mismatch: "живой запрос расходится с архивом",
  proceed: "продолжить",
  older_run: "взять более старый прогон",
  climatology: "климатология",
  accept: "принять прогноз",
  reject: "не публиковать",
  keep_revision_0: "оставить ревизию 0",
  no_update: "без пересчёта",
  frozen: "без коррекции",
  ok: "дрейфа нет",
  no_facts: "факта для сверки нет",
  llm: "сводка от LLM",
  llm_rejected: "LLM отклонена, сводка по шаблону",
  template: "сводка по шаблону",
};

const MODEL_NAME: Record<string, string> = { ...MODEL_LABEL, gfs_power_curve: "кривая мощности по GFS" };

function decisionLabel(code: string): string {
  if (code in DECISION_LABEL) return DECISION_LABEL[code];
  const arrow = /^(fallback|switch) → (.+)$/.exec(code);
  if (arrow) {
    return arrow[1] === "fallback"
      ? `запасная модель: ${MODEL_NAME[arrow[2]] ?? arrow[2]}`
      : `другой источник погоды: ${arrow[2]}`;
  }
  if (code.startsWith("recompute")) return code.replace(/^recompute/, "пересчитать");
  if (code.startsWith("drift:")) return code.replace(/^drift:/, "дрейф:");
  return code;
}

// ---- formatting ---------------------------------------------------------------------------------

const intFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const hoursFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 1 });

const ms = (value: number) => (value < 1 ? "меньше 1 мс" : `${intFmt.format(value)} мс`);

function plural(n: number, one: string, few: string, many: string): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}

// ---- validate_weather args ---------------------------------------------------------------------

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
  margin_h: number | null;
}

function readWeatherArgs(args: Record<string, unknown>): WeatherArgs | null {
  const { covered, hours, fields, source, min_margin_h } = args;
  if (typeof covered !== "number" || typeof hours !== "number" || hours <= 0) return null;
  const parsed: WeatherArgs["fields"] = [];
  if (isRecord(fields)) {
    for (const [key, n] of Object.entries(fields)) {
      if (isWxField(key) && typeof n === "number" && n > 0) parsed.push({ key, hours: n });
    }
  }
  parsed.sort((a, b) => FIELD_ORDER.indexOf(a.key) - FIELD_ORDER.indexOf(b.key));
  return {
    covered,
    hours,
    fields: parsed,
    source: typeof source === "string" && source ? source : null,
    margin_h: typeof min_margin_h === "number" ? min_margin_h : null,
  };
}

function WeatherFacts({ w }: { w: WeatherArgs }) {
  return (
    <div className="mt-3 rounded-md border px-3 py-2.5 text-sm">
      <div className="flex flex-wrap gap-x-5 gap-y-1">
        <span>
          <span className="text-muted-foreground">Покрыто </span>
          <span className="font-medium">
            {w.covered} из {w.hours} ч
          </span>
        </span>
        {w.source && (
          <span>
            <span className="text-muted-foreground">Источник </span>
            <span className="font-medium">{w.source}</span>
          </span>
        )}
        {w.margin_h !== null && (
          <span>
            <span className="text-muted-foreground">Запас публикации </span>
            <span className="font-medium">{hoursFmt.format(w.margin_h)} ч</span>
          </span>
        )}
      </div>
      {w.fields.length > 0 && (
        <>
          <div
            className="mt-2.5 flex h-2 overflow-hidden rounded-full bg-muted"
            role="img"
            aria-label={`Часы горизонта по свежести прогона: ${w.fields
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
        </>
      )}
    </div>
  );
}

// ---- flow of the 9 tools -----------------------------------------------------------------------

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

function FlowStrip({ log }: { log: AgentStep[] }) {
  const flow = useMemo(() => buildFlow(log), [log]);
  const warn = log.filter((s) => s.status === "warn").length;
  const fail = log.filter((s) => s.status === "fail").length;
  const total = log.reduce((sum, s) => sum + s.duration_ms, 0);
  const clean = warn === 0 && fail === 0;
  const notes = [
    fail > 0 ? `${fail} ${plural(fail, "шаг", "шага", "шагов")} со сбоем` : null,
    warn > 0 ? `${warn} ${plural(warn, "шаг", "шага", "шагов")} с пометкой «внимание»` : null,
  ].filter((x): x is string => x !== null);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <CardTitle>Путь выпуска</CardTitle>
          <CardDescription className="mt-1 flex items-center gap-1.5">
            {clean ? (
              <CircleCheck className="size-4 shrink-0 text-[color:var(--ok)]" aria-hidden />
            ) : (
              <TriangleAlert
                className={cn("size-4 shrink-0", fail > 0 ? "text-destructive" : "text-[color:var(--warn)]")}
                aria-hidden
              />
            )}
            {clean
              ? `Все ${log.length} ${plural(log.length, "шаг прошёл", "шага прошли", "шагов прошли")} без замечаний`
              : `Замечания: ${notes.join(", ")}`}
          </CardDescription>
        </div>
        <span className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
          <Timer className="size-4" aria-hidden />
          Агент работал {ms(total)}
        </span>
      </CardHeader>
      <CardContent>
        <ol className="grid grid-cols-3 gap-x-3 gap-y-5 sm:grid-cols-5 lg:grid-cols-9 lg:gap-x-0">
          {flow.map((item, i) => {
            const s = statusOf(item.status);
            const Icon = s.icon;
            const first = item.steps[0];
            const last = i === flow.length - 1;
            const body = (
              <>
                <div className="flex items-center">
                  <Icon className={cn("size-5 shrink-0", s.icon_tone)} aria-hidden />
                  {!last && <span aria-hidden className="mx-2 hidden h-px flex-1 bg-border lg:block" />}
                </div>
                <div className="mt-2 pr-2 text-[13px] leading-snug font-medium group-hover:underline">
                  {TOOL_LABEL[item.tool] ?? item.tool}
                </div>
                <div className={cn("mt-0.5 text-xs", s.text_tone)}>
                  {s.text}
                  {item.steps.length > 1 &&
                    `, ${item.steps.length} ${plural(item.steps.length, "запуск", "запуска", "запусков")}`}
                </div>
              </>
            );
            return (
              <li key={item.tool} className="min-w-0">
                {first ? (
                  <a
                    href={`#step-${first.step}`}
                    className="group block rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                  >
                    {body}
                  </a>
                ) : (
                  <div>{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

// ---- timeline ----------------------------------------------------------------------------------

function StepItem({ step, index, last }: { step: AgentStep; index: number; last: boolean }) {
  const s = statusOf(step.status);
  const weather = step.tool === "validate_weather" ? readWeatherArgs(step.args) : null;
  const label = step.decision ? decisionLabel(step.decision) : null;
  return (
    <li
      id={`step-${step.step}`}
      className="wc-step relative scroll-mt-6 pb-7 pl-11 last:pb-0"
      style={{ animationDelay: `${index * 40}ms` }}
    >
      {!last && <span aria-hidden className="absolute top-9 bottom-1 left-[15px] w-px bg-border" />}
      <span
        className={cn(
          "absolute top-0 left-0 flex size-8 items-center justify-center rounded-full border bg-card text-xs font-semibold",
          step.status === "warn" && "border-[color:var(--warn)]",
          step.status === "fail" && "border-destructive",
        )}
        aria-hidden
      >
        {step.step}
      </span>

      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <h3 className="text-base font-medium">
            <span className="sr-only">Шаг {step.step}: </span>
            {TOOL_LABEL[step.tool] ?? step.tool}
          </h3>
          <code className="font-mono text-xs text-muted-foreground">{step.tool}</code>
        </div>
        <div className="flex items-center gap-3">
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <Timer className="size-3.5" aria-hidden />
            {ms(step.duration_ms)}
          </span>
          <StatusBadge status={step.status} />
        </div>
      </div>

      <p className="mt-1.5 text-sm leading-relaxed text-pretty">{step.summary}</p>

      {step.decision && (
        <div className={cn("mt-3 rounded-md px-3 py-2 text-sm", step.status === "ok" ? "bg-muted/70" : s.soft)}>
          <p className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
            <GitBranch className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground" aria-hidden />
            <span className="font-medium">Решение: {label}</span>
            {label !== step.decision && (
              <code className="font-mono text-xs text-muted-foreground">{step.decision}</code>
            )}
          </p>
          {step.reason && <p className="mt-0.5 pl-5.5 text-muted-foreground">{step.reason}</p>}
        </div>
      )}

      {weather && <WeatherFacts w={weather} />}

      {step.llm && (
        <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <MessageSquareText className="size-3.5" aria-hidden />
          LLM: {step.llm.provider} {step.llm.model}, {intFmt.format(step.llm.tokens)}{" "}
          {plural(step.llm.tokens, "токен", "токена", "токенов")}
        </p>
      )}
    </li>
  );
}

// ---- side panel --------------------------------------------------------------------------------

const PRINCIPLES: { icon: LucideIcon; text: string }[] = [
  {
    icon: Calculator,
    text: "Все числа считают детерминированные инструменты: погода, признаки, модель и проверки.",
  },
  {
    icon: GitBranch,
    text: "На развилках решают пороги: более старый прогон → другой источник погоды → запасная модель → климатология.",
  },
  {
    icon: RefreshCw,
    text: "Когда выходит новый прогон погоды, выпуск пересчитывается и проходит те же проверки, что и основной.",
  },
  {
    icon: MessageSquareText,
    text: "LLM только объясняет: каждое число в её тексте сверяется с фактами выпуска, иначе остаётся сводка по шаблону.",
  },
];

function IssueFacts({ issue }: { issue: ForecastIssue }) {
  const issuedAt = issue.rows[0]?.issue_time_local;
  const rows: { term: string; value: ReactNode }[] = [
    { term: "Выпуск за", value: dayLabel(issue.issue_date) },
    ...(issuedAt ? [{ term: "Прогноз сделан", value: `${when(issuedAt)} (Алматы)` }] : []),
    { term: "Модель", value: MODEL_NAME[issue.model_name] ?? issue.model_name },
    { term: "Последняя ревизия", value: String(issue.revision) },
    {
      term: "Запасной путь",
      value: issue.fallback_used ? (
        <span className="inline-flex items-center gap-1">
          <TriangleAlert className="size-3.5 text-[color:var(--warn)]" aria-hidden />
          использован
        </span>
      ) : (
        <span className="inline-flex items-center gap-1">
          <CircleCheck className="size-3.5 text-[color:var(--ok)]" aria-hidden />
          не понадобился
        </span>
      ),
    },
    { term: "Прогон", value: <code className="font-mono text-xs break-all">{issue.run_id}</code> },
  ];
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Этот выпуск</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1.5 text-sm">
          {rows.map((r) => (
            <div key={r.term} className="contents">
              <dt className="text-muted-foreground">{r.term}</dt>
              <dd className="min-w-0">{r.value}</dd>
            </div>
          ))}
        </dl>
      </CardContent>
    </Card>
  );
}

function HowItWorks() {
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Как устроен агент</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col gap-3 text-sm leading-relaxed">
          {PRINCIPLES.map(({ icon: Icon, text }) => (
            <li key={text} className="flex gap-2.5">
              <Icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
              <span>{text}</span>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
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
        <AlertDescription>{error.message}. Выберите другую дату в списке выпусков.</AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <ServerCrash />
      <AlertTitle>Сервис прогноза не отвечает</AlertTitle>
      <AlertDescription>
        <p>
          {error.status > 0
            ? `Ответ ${error.status}: ${error.message}.`
            : "Браузер не получил ответ от /api."}{" "}
          Запустите API из корня проекта и обновите страницу:
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
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Загрузка журнала агента">
      <Skeleton className="h-36 w-full rounded-xl" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex flex-col gap-6 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex flex-1 flex-col gap-2">
                <Skeleton className="h-5 w-48" />
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-10 w-full" />
              </div>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-6">
          <Skeleton className="h-52 w-full rounded-xl" />
          <Skeleton className="h-60 w-full rounded-xl" />
        </div>
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
          <AlertDescription>Агент ещё не собрал ни одного прогноза, журнал появится после первого выпуска.</AlertDescription>
        </Alert>
      );
    else body = <LoadingState />;
  } else if (!current) {
    body = <LoadingState />;
  } else if (current.error || !issue) {
    body = current.error ? <ErrorAlert error={current.error} /> : <LoadingState />;
  } else {
    body = (
      <div className="flex flex-col gap-6">
        <FlowStrip log={current.log} />

        {issue.warnings.length > 0 && (
          <Alert>
            <TriangleAlert className="text-[color:var(--warn)]" />
            <AlertTitle>Предупреждения выпуска</AlertTitle>
            <AlertDescription>
              <ul className="list-disc pl-4">
                {issue.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
          <Card>
            <CardHeader>
              <CardTitle>Журнал шагов</CardTitle>
              <CardDescription>Что сделал каждый инструмент, какое решение принял и почему.</CardDescription>
            </CardHeader>
            <CardContent>
              {current.log.length === 0 ? (
                <p className="text-sm text-muted-foreground">Для этого прогона журнал пуст.</p>
              ) : (
                <ol>
                  {current.log.map((step, i) => (
                    <StepItem
                      key={`${step.run_id}-${step.step}`}
                      step={step}
                      index={i}
                      last={i === current.log.length - 1}
                    />
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
          <aside className="flex flex-col gap-6 lg:sticky lg:top-6">
            <HowItWorks />
            <IssueFacts issue={issue} />
          </aside>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">Агент</h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            {date
              ? `Как агент собрал выпуск за ${dayLabel(date)}: что проверил, где выбирал и почему.`
              : "Как агент собирает выпуск: что проверяет, где выбирает и почему."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {issues && issues.length > 0 && date && <IssuePicker issues={issues} value={date} onChange={choose} />}
          {issue && (
            <a
              href={`/api/runs/${encodeURIComponent(issue.run_id)}/log`}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: "outline" })}
            >
              <FileBraces aria-hidden />
              Журнал JSON
            </a>
          )}
        </div>
      </div>
      {body}
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

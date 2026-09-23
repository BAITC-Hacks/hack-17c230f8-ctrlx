"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  Bot,
  ChevronLeft,
  ChevronRight,
  CircleAlert,
  FileSpreadsheet,
  Info,
  LoaderCircle,
  RefreshCw,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { ForecastChart } from "@/components/charts";
import { Explain, PLAIN, PageHeader, Section, Stat, StatRow } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  MODEL_LABEL,
  RATED_MW,
  api,
  bidRows,
  dayLabel,
  latestRows,
  mw,
  mwh,
  planRows,
  when,
  type ForecastIssue,
  type ForecastRow,
  type IssueListItem,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Series = "power_farm" | "power_t1" | "power_t2";

const SERIES: { value: Series; label: string }[] = [
  { value: "power_farm", label: "Станция" },
  { value: "power_t1", label: "Турбина 1" },
  { value: "power_t2", label: "Турбина 2" },
];

// Below 5 % of rated power the turbines are practically standing: counted as calm.
const CALM_LEVEL = 0.05;
const START_API = "uv run uvicorn app.main:app --port 8000";

const isSeries = (v: unknown): v is Series => SERIES.some((s) => s.value === v);

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(-1, e instanceof Error ? e.message : String(e));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "62 МВт·ч" → ["62", "МВт·ч"]: the number is set large, the unit small. */
function splitUnit(s: string): [string, string] {
  const i = s.lastIndexOf(" ");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

function dayEnergy(rows: ForecastRow[]) {
  if (!rows.length) return null;
  // hourly rows: share × rated MW × 1 h = MWh
  return { day: rows[0].target_time_local, energy: rows.reduce((s, r) => s + r.power_farm, 0) * RATED_MW };
}

// ---- agent summary → a few plain lines ---------------------------------------------------------

// The first bullets repeat the numbers above (days, peak, corridor), so the short list starts from these.
const NOTE_ORDER = ["Риски", "Пересчёт", "По сравнению", "Самопроверка"];

const PLAIN_WORDS: [RegExp, string][] = [
  [/\s*\((ревизия \d|оперативный прогноз)\)/g, ""],
  [/Риски исходного прогноза/g, "Риски"],
  [/^Пересчёт/, "Уточнение"],
  [/более свежий прогон/g, "свежий прогноз погоды"],
  [/\s*p10–p90/g, ""],
  [/прошлым выпуском/g, "вчерашним прогнозом"],
  [/прошлым выпускам/g, "прошлым прогнозам"],
  [/опубликованных выпусков/g, "опубликованных прогнозов"],
];

const plain = (s: string) => PLAIN_WORDS.reduce((t, [re, to]) => t.replace(re, to), s);

function parseSummary(summary: string) {
  const lines = summary
    .split("\n")
    .map((l) => l.replace(/\*\*/g, "").trim())
    .filter(Boolean);
  const bullets = lines.filter((l) => l.startsWith("- ")).map((l) => l.slice(2));
  const paragraphs = lines.filter((l) => !l.startsWith("- "));
  const picked = NOTE_ORDER.map((p) => bullets.find((b) => b.startsWith(p))).filter(
    (b): b is string => b !== undefined,
  );
  const source = picked.length ? picked : bullets.length ? bullets : paragraphs.slice(1);
  return { paragraphs, bullets, notes: source.slice(0, 4).map(plain) };
}

/** "Риски: штиль 5 ч" → bold "Риски:" so the line can be scanned. */
function NoteText({ text }: { text: string }) {
  const i = text.indexOf(": ");
  if (i <= 0 || i > 64) return <>{text}</>;
  return (
    <>
      <span className="font-medium text-foreground">{text.slice(0, i + 1)}</span>
      {text.slice(i + 1)}
    </>
  );
}

// ---- states ------------------------------------------------------------------------------------

function ErrorAlert({ title, error, onRetry }: { title: string; error: ApiError; onRetry?: () => void }) {
  const offline = error.status === 0;
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-3">
        <div>{offline ? "Сервис прогноза не отвечает. Запустите его:" : capitalize(error.message)}</div>
        <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{START_API}</code>
        {onRetry && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            <RefreshCw aria-hidden />
            Повторить
          </Button>
        )}
      </AlertDescription>
    </Alert>
  );
}

function BodySkeleton() {
  return (
    <div className="flex flex-col gap-12" aria-busy="true" aria-label="Загрузка прогноза">
      <StatRow>
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-20" />
            <Skeleton className="h-10 w-28" />
            <Skeleton className="h-4 w-24" />
          </div>
        ))}
      </StatRow>
      <Skeleton className="h-96 rounded-xl" />
    </div>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true" aria-label="Загрузка прогноза">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-72" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <Skeleton className="h-8 w-full sm:w-96" />
      <BodySkeleton />
    </div>
  );
}

// ---- one day's forecast ------------------------------------------------------------------------

function IssueBody({ issue, series, onSeries }: {
  issue: ForecastIssue;
  series: Series;
  onSeries: (s: Series) => void;
}) {
  const rows = issue.rows;
  const latest = latestRows(rows);
  const today = dayEnergy(planRows(rows));
  const tomorrow = dayEnergy(bidRows(rows));
  const peak = latest.length ? latest.reduce((a, b) => (b.power_farm > a.power_farm ? b : a)) : null;
  const calm = latest.filter((r) => r.power_farm < CALM_LEVEL).length;
  const { paragraphs, bullets, notes } = parseSummary(issue.summary);
  const model = MODEL_LABEL[issue.model_name] ?? issue.model_name;

  const [todayN, todayU] = today ? splitUnit(mwh(today.energy, 0)) : ["—", ""];
  const [tomorrowN, tomorrowU] = tomorrow ? splitUnit(mwh(tomorrow.energy, 0)) : ["—", ""];
  const [peakN, peakU] = peak ? splitUnit(mw(peak.power_farm)) : ["—", ""];

  return (
    <>
      <div className="flex flex-col gap-12">
        {(issue.fallback_used || issue.warnings.length > 0) && (
          <div className="flex flex-col gap-3">
            {issue.fallback_used && (
              <Alert>
                <ShieldAlert aria-hidden className="text-(--warn)" />
                <AlertTitle>Прогноз сделан запасной моделью: {model}</AlertTitle>
                <AlertDescription>Основная модель не прошла проверку агента.</AlertDescription>
              </Alert>
            )}
            {issue.warnings.length > 0 && (
              <Alert>
                <TriangleAlert aria-hidden className="text-(--warn)" />
                <AlertTitle>Агент предупреждает</AlertTitle>
                <AlertDescription className="text-foreground">
                  <ul className="flex list-disc flex-col gap-1 pl-4">
                    {issue.warnings.map((w, i) => (
                      <li key={i}>{w}</li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            )}
          </div>
        )}

        <StatRow>
          <Stat label="Сегодня" value={todayN} unit={todayU} note={today ? dayLabel(today.day) : "нет данных"} />
          <Stat label="Завтра" value={tomorrowN} unit={tomorrowU} tone="accent" note="уходит в заявку" />
          <Stat label="Пик" value={peakN} unit={peakU} note={peak ? when(peak.target_time_local) : "нет данных"} />
          <Stat label="Штиль" value={calm} unit="ч" note="турбины почти стоят" />
        </StatRow>

        <Card className="gap-8 overflow-visible [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(8)]">
          <CardContent className="flex flex-col gap-6">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
              <Tabs value={series} onValueChange={(v: unknown) => isSeries(v) && onSeries(v)}>
                <TabsList aria-label="Что показать на графике">
                  {SERIES.map((s) => (
                    <TabsTrigger key={s.value} value={s.value} className="px-3">
                      {s.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              <Explain>
                <ul className="flex flex-col gap-2">
                  <li>
                    <b>Линия</b> — ожидаемая мощность.
                  </li>
                  <li>
                    <b>Полоса</b> — {PLAIN.band}.
                  </li>
                  <li>
                    <b>Пунктир</b> — версия до уточнения в 12:00.
                  </li>
                  <li>
                    <b>Вертикальная черта</b> — начало завтрашних суток, они уходят в заявку.
                  </li>
                  <li className="text-muted-foreground">
                    Шкала — % от мощности станции, 100 = {RATED_MW} МВт. У турбины — % от её 2,5 МВт, коридора нет.
                  </li>
                </ul>
              </Explain>
            </div>
            <ForecastChart rows={rows} series={series} />
          </CardContent>
        </Card>
      </div>

      <Section title="Коротко от агента" className="mt-12">
        {notes.length > 0 ? (
          <ul className="flex max-w-prose flex-col gap-4 text-base leading-relaxed text-muted-foreground">
            {notes.map((t, i) => (
              <li key={i} className="flex gap-3">
                <span aria-hidden className="mt-2.5 size-1.5 shrink-0 rounded-full bg-primary" />
                <span>
                  <NoteText text={t} />
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground">Агент не приложил сводку.</p>
        )}

        {(paragraphs.length > 0 || bullets.length > 0) && (
          <details className="group mt-8">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-md text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight aria-hidden className="size-4 transition-transform duration-150 group-open:rotate-90" />
              Вся сводка
            </summary>
            <div className="mt-4 flex max-w-prose flex-col gap-3 text-sm leading-relaxed text-muted-foreground">
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
              {bullets.length > 0 && (
                <ul className="flex list-disc flex-col gap-1.5 pl-5">
                  {bullets.map((b, i) => (
                    <li key={i}>{b}</li>
                  ))}
                </ul>
              )}
              <p>
                Прогон агента: <code className="font-mono text-xs break-all">{issue.run_id}</code>
              </p>
            </div>
          </details>
        )}
      </Section>
    </>
  );
}

// ---- page --------------------------------------------------------------------------------------

function IssuesView() {
  const router = useRouter();
  const requested = useSearchParams().get("date");

  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [listError, setListError] = useState<ApiError | null>(null);
  const [listKey, setListKey] = useState(0);
  const [issue, setIssue] = useState<ForecastIssue | null>(null);
  const [issueError, setIssueError] = useState<{ date: string; error: ApiError } | null>(null);
  const [issueKey, setIssueKey] = useState(0);
  const [series, setSeries] = useState<Series>("power_farm");
  const [running, setRunning] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .issues()
      .then((list) => {
        if (cancelled) return;
        setIssues(list);
        setListError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setListError(toApiError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [listKey]);

  const index = issues && requested ? issues.findIndex((i) => i.issue_date === requested) : -1;
  const date = issues?.length ? (index >= 0 ? issues[index].issue_date : issues[0].issue_date) : null;
  const pos = issues && date ? issues.findIndex((i) => i.issue_date === date) : -1;
  const prev = issues && pos > 0 ? issues[pos - 1].issue_date : null;
  const next = issues && pos >= 0 && pos < issues.length - 1 ? issues[pos + 1].issue_date : null;
  const missing = issues && requested && index < 0 ? requested : null;

  useEffect(() => {
    if (!date) return;
    let cancelled = false;
    api
      .forecast(date)
      .then((f) => {
        if (cancelled) return;
        setIssue(f);
        setIssueError(null);
      })
      .catch((e: unknown) => {
        if (!cancelled) setIssueError({ date, error: toApiError(e) });
      });
    return () => {
      cancelled = true;
    };
  }, [date, issueKey]);

  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [running]);

  const go = (d: string | null) => {
    if (d) router.replace(`/issues?date=${d}`, { scroll: false });
  };

  async function recompute() {
    if (!date || running) return;
    const d = date;
    setElapsed(0);
    setRunning(d);
    try {
      const res = await api.run(d);
      setIssue(res.issue);
      toast.success("Прогноз пересчитан", { description: capitalize(dayLabel(d)) });
      setIssueKey((k) => k + 1);
      setListKey((k) => k + 1);
    } catch (e: unknown) {
      const err = toApiError(e);
      toast.error(err.status === 422 ? "Агент не стал пересчитывать" : "Не удалось пересчитать", {
        description: capitalize(err.message),
      });
    } finally {
      setRunning(null);
    }
  }

  if (listError && !issues) {
    return <ErrorAlert title="Не удалось загрузить прогнозы" error={listError} onRetry={() => setListKey((k) => k + 1)} />;
  }
  if (!issues) return <PageSkeleton />;

  if (!issues.length || !date) {
    return (
      <div>
        <PageHeader title="Прогноз на 48 часов" />
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Прогнозов пока нет</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-2">
            Сделайте первый командой:
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              uv run python -m app.cli forecast --issue 2026-01-31
            </code>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const failed = issueError && issueError.date === date ? issueError.error : null;
  // while the next day loads, the previous one stays on screen, dimmed
  const display = failed ? null : issue;
  const stale = display !== null && display.issue_date !== date;
  const items = Object.fromEntries(issues.map((i) => [i.issue_date, capitalize(dayLabel(i.issue_date))]));
  const q = `?date=${date}`;

  return (
    <div>
      <PageHeader title="Прогноз на 48 часов" lead="Выберите день: линия — ожидаемая мощность, полоса — коридор" />

      <div className="flex flex-wrap items-center gap-3 pb-12">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button variant="outline" size="icon" aria-label="Предыдущий день" disabled={!prev} onClick={() => go(prev)}>
            <ChevronLeft aria-hidden />
          </Button>
          <Select items={items} value={date} onValueChange={(v) => go(v)}>
            <SelectTrigger aria-label="День" className="min-w-0 flex-1 sm:w-48 sm:flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {issues.map((i) => (
                <SelectItem key={i.issue_date} value={i.issue_date}>
                  {items[i.issue_date]}
                  {i.fallback_used ? " (запасная модель)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" aria-label="Следующий день" disabled={!next} onClick={() => go(next)}>
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <span className="sr-only" aria-live="polite">
          {running ? `Агент пересчитывает прогноз на ${dayLabel(running)}` : ""}
        </span>
        <Button onClick={recompute} disabled={running !== null}>
          {running ? (
            <>
              <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
              {elapsed >= 2 ? `Агент считает, ${elapsed} с` : "Агент считает…"}
            </>
          ) : (
            <>
              <RefreshCw aria-hidden />
              Пересчитать
            </>
          )}
        </Button>
        <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
          <Link href={`/bid${q}`} className={buttonVariants({ variant: "ghost" })}>
            <FileSpreadsheet aria-hidden />
            Заявка на завтра
          </Link>
          <Link href={`/agent${q}`} className={buttonVariants({ variant: "ghost" })}>
            <Bot aria-hidden />
            Что сделал агент
          </Link>
        </div>
      </div>

      {missing && (
        <Alert className="mb-10">
          <Info aria-hidden />
          <AlertTitle>
            Прогноза на {/^\d{4}-\d{2}-\d{2}$/.test(missing) ? dayLabel(missing) : missing} нет, показан{" "}
            {dayLabel(date)}
          </AlertTitle>
        </Alert>
      )}

      {failed ? (
        <ErrorAlert
          title={`Не удалось загрузить прогноз на ${dayLabel(date)}`}
          error={failed}
          onRetry={() => setIssueKey((k) => k + 1)}
        />
      ) : display ? (
        <div
          aria-busy={stale}
          className={cn("transition-opacity duration-200", stale && "pointer-events-none opacity-50")}
        >
          <IssueBody issue={display} series={series} onSeries={setSeries} />
        </div>
      ) : (
        <BodySkeleton />
      )}
    </div>
  );
}

export default function IssuesPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IssuesView />
    </Suspense>
  );
}

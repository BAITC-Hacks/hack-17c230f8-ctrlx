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
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  MODEL_LABEL,
  RATED_MW,
  WX_FIELD_LABEL,
  api,
  bidRows,
  dayLabel,
  latestRows,
  mw,
  mwh,
  pct,
  planRows,
  when,
  type ForecastIssue,
  type ForecastRow,
  type IssueListItem,
  type WxField,
} from "@/lib/api";
import { cn } from "@/lib/utils";

type Series = "power_farm" | "power_t1" | "power_t2";

const SERIES: { value: Series; label: string }[] = [
  { value: "power_farm", label: "Станция" },
  { value: "power_t1", label: "Турбина 1" },
  { value: "power_t2", label: "Турбина 2" },
];

const CALM_LEVEL = 0.05;
const START_API = "uv run uvicorn app.main:app --port 8000";

const isSeries = (v: unknown): v is Series => SERIES.some((s) => s.value === v);

function toApiError(e: unknown): ApiError {
  if (e instanceof ApiError) return e;
  return new ApiError(-1, e instanceof Error ? e.message : String(e));
}

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "62,3 МВт·ч" → ["62,3", "МВт·ч"]: the number is set large, the unit small. */
function splitUnit(s: string): [string, string] {
  const i = s.lastIndexOf(" ");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

// ---- derived numbers (all from the issue rows) -------------------------------------------------

function dayStats(rows: ForecastRow[]) {
  if (!rows.length) return null;
  const sum = rows.reduce((s, r) => s + r.power_farm, 0);
  // hourly rows: share × rated MW × 1 h = MWh
  return { day: rows[0].target_time_local, mean: sum / rows.length, energy: sum * RATED_MW };
}

function recomputeInfo(rows: ForecastRow[]) {
  const rev1 = rows.filter((r) => r.revision === 1);
  if (!rev1.length) return null;
  const rev0 = new Map(rows.filter((r) => r.revision === 0).map((r) => [r.lead_h, r]));
  let biggest: { delta: number; row: ForecastRow } | null = null;
  for (const r of rev1) {
    const before = rev0.get(r.lead_h);
    if (!before) continue;
    const delta = Math.abs(r.power_farm - before.power_farm);
    if (!biggest || delta > biggest.delta) biggest = { delta, row: r };
  }
  // revision 1 is the intraday recompute at t0 + 12 h, i.e. the target time of lead 12
  const at = rows.find((r) => r.revision === 0 && r.lead_h === 12)?.target_time_local ?? null;
  const first = rev1.reduce((a, b) => (b.lead_h < a.lead_h ? b : a));
  return { hours: rev1.length, at, from: first.target_time_local, biggest };
}

type SummaryBlock = { kind: "p"; text: string } | { kind: "ul"; items: string[] };

function parseSummary(summary: string): { lead: string | null; blocks: SummaryBlock[] } {
  const lines = summary
    .split("\n")
    .map((l) => l.replace(/\*\*/g, "").trim())
    .filter(Boolean);
  const lead = lines[0] && !lines[0].startsWith("- ") ? lines[0] : null;
  const blocks: SummaryBlock[] = [];
  for (const line of lead ? lines.slice(1) : lines) {
    if (line.startsWith("- ")) {
      const last = blocks[blocks.length - 1];
      if (last?.kind === "ul") last.items.push(line.slice(2));
      else blocks.push({ kind: "ul", items: [line.slice(2)] });
    } else {
      blocks.push({ kind: "p", text: line });
    }
  }
  return { lead, blocks };
}

/** "Пик: 11 февраля, 02:00 — 98%" → bold "Пик:" so the dispatcher can scan the list. */
function SummaryItem({ text }: { text: string }) {
  const i = text.indexOf(": ");
  if (i <= 0 || i > 64) return <>{text}</>;
  return (
    <>
      <span className="font-medium">{text.slice(0, i + 1)}</span>
      {text.slice(i + 1)}
    </>
  );
}

// ---- small pieces ----------------------------------------------------------------------------

function Kpi({ label, value, note }: { label: string; value: string | null; note: string }) {
  const [n, unit] = value ? splitUnit(value) : ["—", ""];
  return (
    <div className="flex flex-col gap-1 rounded-xl bg-card p-4 ring-1 ring-foreground/10 last:col-span-2 sm:last:col-span-1">
      <div className="truncate text-sm text-muted-foreground">{label}</div>
      <div className="flex items-baseline gap-1">
        <span className="text-2xl font-semibold tracking-tight tabular-nums">{n}</span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>
      <div className="text-sm leading-snug text-muted-foreground">{note}</div>
    </div>
  );
}

function ErrorAlert({ title, error, onRetry }: { title: string; error: ApiError; onRetry?: () => void }) {
  const offline = error.status === 0;
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription className="flex flex-col items-start gap-2">
        <div>{offline ? "Сервис прогноза не отвечает." : capitalize(error.message)}</div>
        <div>
          {offline ? "Запустите его" : "Если сервис не запущен, запустите его"} из корня проекта:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{START_API}</code>
        </div>
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

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Загрузка выпуска">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-5 w-full max-w-xl" />
      </div>
      <div className="flex flex-wrap gap-2">
        <Skeleton className="h-8 w-full sm:w-80" />
        <Skeleton className="h-8 w-full sm:ml-auto sm:w-96" />
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-28 last:col-span-2 sm:last:col-span-1" />
        ))}
      </div>
      <Skeleton className="h-96" />
    </div>
  );
}

// ---- the issue itself -----------------------------------------------------------------------

function IssueBody({ issue, series, onSeries }: {
  issue: ForecastIssue;
  series: Series;
  onSeries: (s: Series) => void;
}) {
  const rows = issue.rows;
  const latest = latestRows(rows);
  const d1 = dayStats(planRows(rows));
  const d2 = dayStats(bidRows(rows));
  const peak = latest.length ? latest.reduce((a, b) => (b.power_farm > a.power_farm ? b : a)) : null;
  const calm = latest.filter((r) => r.power_farm < CALM_LEVEL).length;
  const width = latest.length ? latest.reduce((s, r) => s + (r.p90 - r.p10), 0) / latest.length : null;
  const rec = recomputeInfo(rows);
  const issuedAt = rows[0]?.issue_time_local ?? null;
  const wx = (["day1", "day2", "day3", "none"] as WxField[])
    .map((f) => ({ field: f, hours: latest.filter((r) => r.wx_field === f).length }))
    .filter((x) => x.hours > 0);
  const { lead, blocks } = parseSummary(issue.summary);
  const model = MODEL_LABEL[issue.model_name] ?? issue.model_name;

  return (
    <>
      {issue.fallback_used && (
        <Alert>
          <ShieldAlert aria-hidden className="text-(--warn)" />
          <AlertTitle>Выпуск сделан резервной моделью: {model}</AlertTitle>
          <AlertDescription>
            Основная модель не прошла проверку, агент переключился на запасной вариант. Подробности в журнале агента.
          </AlertDescription>
        </Alert>
      )}

      {issue.warnings.length > 0 && (
        <Alert>
          <TriangleAlert aria-hidden className="text-(--warn)" />
          <AlertTitle>
            {issue.warnings.length === 1 ? "Предупреждение агента" : `Предупреждения агента: ${issue.warnings.length}`}
          </AlertTitle>
          <AlertDescription className="text-foreground">
            <ul className="flex list-disc flex-col gap-1 pl-4">
              {issue.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <section aria-label="Главные числа выпуска" className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <Kpi
          label={d1 ? `${dayLabel(d1.day)} (D+1)` : "Сутки D+1"}
          value={d1 ? mwh(d1.energy) : null}
          note={d1 ? `план на сутки, в среднем ${pct(d1.mean)} номинала (${mw(d1.mean)})` : "нет часов в выпуске"}
        />
        <Kpi
          label={d2 ? `${dayLabel(d2.day)} (D+2)` : "Сутки D+2"}
          value={d2 ? mwh(d2.energy) : null}
          note={d2 ? `черновик заявки, в среднем ${pct(d2.mean)} (${mw(d2.mean)})` : "нет часов в выпуске"}
        />
        <Kpi
          label="Пик за 48 ч"
          value={peak ? pct(peak.power_farm) : null}
          note={peak ? `${when(peak.target_time_local)} — ${mw(peak.power_farm)}` : "нет данных"}
        />
        <Kpi label="Часы штиля" value={`${calm} ч`} note="выработка ниже 5 % номинала" />
        <Kpi
          label="Коридор p10–p90"
          value={width === null ? null : pct(width)}
          note={width === null ? "нет данных" : `средняя ширина за 48 ч, ${mw(width)}`}
        />
      </section>

      <Card>
        <CardHeader>
          <CardTitle>Прогноз на 48 часов</CardTitle>
          <CardDescription>
            {issuedAt ? `Прогноз сделан ${when(issuedAt)} по Алматы. ` : ""}
            Шкала — процент номинала: 100 = {RATED_MW} МВт для станции.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <Tabs value={series} onValueChange={(v: unknown) => isSeries(v) && onSeries(v)}>
              <TabsList aria-label="Что показать на графике">
                {SERIES.map((s) => (
                  <TabsTrigger key={s.value} value={s.value} className="px-3">
                    {s.label}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground" aria-label="Легенда">
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-0.5 w-5 rounded-full bg-primary" />
                прогноз, медиана
              </li>
              <li className="flex items-center gap-2">
                <span aria-hidden className="h-3 w-5 rounded-sm bg-primary/15" />
                коридор p10–p90
              </li>
              {rec && (
                <li className="flex items-center gap-2">
                  <span aria-hidden className="w-5 border-t-2 border-dashed border-foreground/45" />
                  до пересчёта
                </li>
              )}
            </ul>
          </div>
          {series !== "power_farm" && (
            <p className="flex items-start gap-2 text-sm text-muted-foreground">
              <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
              Линия турбины — доля её собственного номинала 2,5 МВт; коридор p10–p90 рассчитан для станции.
            </p>
          )}
          <ForecastChart rows={rows} series={series} />
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>Сводка диспетчеру</CardTitle>
            <CardDescription>Текст, который агент приложил к выпуску.</CardDescription>
          </CardHeader>
          <CardContent className="flex max-w-prose flex-col gap-3 text-base leading-relaxed">
            {lead && <p className="font-medium">{lead}</p>}
            {blocks.map((b, i) =>
              b.kind === "ul" ? (
                <ul key={i} className="flex list-disc flex-col gap-1.5 pl-5 marker:text-muted-foreground">
                  {b.items.map((t, j) => (
                    <li key={j}>
                      <SummaryItem text={t} />
                    </li>
                  ))}
                </ul>
              ) : (
                <p key={i}>{b.text}</p>
              ),
            )}
            {!lead && blocks.length === 0 && <p className="text-muted-foreground">Агент не приложил сводку к этому выпуску.</p>}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>О выпуске</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="flex flex-col gap-4 text-sm">
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Пересчёт</dt>
                <dd className="flex items-start gap-2">
                  <RefreshCw aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
                  {rec ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="font-medium">
                        Пересчитано часов: {rec.hours} из {latest.length}
                      </span>
                      <span className="text-muted-foreground">
                        {`Пересчёт${rec.at ? ` ${when(rec.at)}` : ""} по более свежему прогону погоды, `}
                        {`затронуты часы начиная с ${when(rec.from)}.`}
                      </span>
                      {rec.biggest && rec.biggest.delta > 0 && (
                        <span className="text-muted-foreground">
                          Наибольшее изменение: {pct(rec.biggest.delta)} ({mw(rec.biggest.delta)}),{" "}
                          {when(rec.biggest.row.target_time_local)}.
                        </span>
                      )}
                    </div>
                  ) : (
                    <span>Пересчёта не было: опубликован исходный прогноз.</span>
                  )}
                </dd>
              </div>
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Модель</dt>
                <dd className="flex flex-wrap items-center gap-2">
                  {capitalize(model)}
                  {issue.fallback_used && (
                    <Badge variant="outline">
                      <ShieldAlert aria-hidden />
                      резервная
                    </Badge>
                  )}
                </dd>
              </div>
              {wx.length > 0 && (
                <div className="flex flex-col gap-1">
                  <dt className="text-muted-foreground">Прогон погоды по часам</dt>
                  <dd>
                    <ul className="flex flex-col gap-0.5">
                      {wx.map((x) => (
                        <li key={x.field} className="flex justify-between gap-3">
                          <span>{capitalize(WX_FIELD_LABEL[x.field])}</span>
                          <span className="tabular-nums text-muted-foreground">{x.hours} ч</span>
                        </li>
                      ))}
                    </ul>
                  </dd>
                </div>
              )}
              <div className="flex flex-col gap-1">
                <dt className="text-muted-foreground">Прогон агента</dt>
                <dd className="font-mono text-xs break-all">{issue.run_id}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

// ---- page ------------------------------------------------------------------------------------

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
      toast.success("Выпуск пересчитан агентом", {
        description: `Выпуск за ${dayLabel(d)}, новый прогон ${res.run_id}.`,
      });
      setIssueKey((k) => k + 1);
      setListKey((k) => k + 1);
    } catch (e: unknown) {
      const err = toApiError(e);
      toast.error(err.status === 422 ? "Агент не стал пересчитывать выпуск" : "Не удалось пересчитать выпуск", {
        description:
          err.status === 422
            ? `${capitalize(err.message)}. Пересчитать можно только выпуски после периода обучения модели.`
            : capitalize(err.message),
      });
    } finally {
      setRunning(null);
    }
  }

  if (listError && !issues) {
    return <ErrorAlert title="Не удалось загрузить список выпусков" error={listError} onRetry={() => setListKey((k) => k + 1)} />;
  }
  if (!issues) return <PageSkeleton />;

  if (!issues.length || !date) {
    return (
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-semibold tracking-tight">Выпуски прогноза</h1>
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Выпусков пока нет</AlertTitle>
          <AlertDescription>
            Агент ещё не выпустил ни одного прогноза. Первый выпуск можно сделать командой{" "}
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
              uv run python -m app.cli forecast --issue 2026-01-31
            </code>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const failed = issueError && issueError.date === date ? issueError.error : null;
  // while the next issue loads, the previous one stays on screen, dimmed
  const display = failed ? null : issue;
  const stale = display !== null && display.issue_date !== date;
  const items = Object.fromEntries(issues.map((i) => [i.issue_date, `Выпуск за ${dayLabel(i.issue_date)}`]));
  const q = `?date=${date}`;

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Выпуски прогноза</h1>
        <p className="max-w-3xl text-muted-foreground">
          Агент выпускает прогноз выработки на 48 часов в 00:00 по Алматы и пересчитывает его в 12:00, если вышел
          более свежий прогон погоды.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <Button variant="outline" size="icon" aria-label="Предыдущий выпуск" disabled={!prev} onClick={() => go(prev)}>
            <ChevronLeft aria-hidden />
          </Button>
          <Select items={items} value={date} onValueChange={(v) => go(v)}>
            <SelectTrigger aria-label="Выпуск" className="min-w-0 flex-1 sm:w-60 sm:flex-none">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {issues.map((i) => (
                <SelectItem key={i.issue_date} value={i.issue_date}>
                  {items[i.issue_date]}
                  {i.fallback_used ? " (резервная модель)" : ""}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="icon" aria-label="Следующий выпуск" disabled={!next} onClick={() => go(next)}>
            <ChevronRight aria-hidden />
          </Button>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:ml-auto">
          <Link href={`/agent${q}`} className={buttonVariants({ variant: "outline" })}>
            <Bot aria-hidden />
            Журнал агента
          </Link>
          <Link href={`/bid${q}`} className={buttonVariants({ variant: "outline" })}>
            <FileSpreadsheet aria-hidden />
            Суточная заявка
          </Link>
          <span className="sr-only" aria-live="polite">
            {running ? `Агент пересчитывает выпуск за ${dayLabel(running)}` : ""}
          </span>
          <Button onClick={recompute} disabled={running !== null}>
            {running ? (
              <>
                <LoaderCircle aria-hidden className="motion-safe:animate-spin" />
                {`Агент пересчитывает${elapsed >= 2 ? `, ${elapsed} с` : "…"}`}
              </>
            ) : (
              <>
                <RefreshCw aria-hidden />
                Пересчитать выпуск
              </>
            )}
          </Button>
        </div>
      </div>

      {missing && (
        <Alert>
          <Info aria-hidden />
          <AlertTitle>Выпуска за {/^\d{4}-\d{2}-\d{2}$/.test(missing) ? dayLabel(missing) : missing} нет</AlertTitle>
          <AlertDescription>Показан выпуск за {dayLabel(date)}.</AlertDescription>
        </Alert>
      )}

      {failed ? (
        <ErrorAlert
          title={`Не удалось загрузить выпуск за ${dayLabel(date)}`}
          error={failed}
          onRetry={() => setIssueKey((k) => k + 1)}
        />
      ) : display ? (
        <div
          aria-busy={stale}
          className={cn("flex flex-col gap-6 transition-opacity duration-200", stale && "pointer-events-none opacity-50")}
        >
          <IssueBody issue={display} series={series} onSeries={setSeries} />
        </div>
      ) : (
        <div className="flex flex-col gap-6" aria-busy="true" aria-label="Загрузка выпуска">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} className="h-28 last:col-span-2 sm:last:col-span-1" />
            ))}
          </div>
          <Skeleton className="h-96" />
        </div>
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

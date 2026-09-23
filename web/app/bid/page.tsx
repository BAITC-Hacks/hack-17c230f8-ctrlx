"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, CircleCheck, Download, TriangleAlert } from "lucide-react";
import { toast } from "sonner";
import {
  ApiError,
  type ForecastIssue,
  type ForecastRow,
  type IssueListItem,
  MODEL_LABEL,
  RATED_MW,
  WX_FIELD_LABEL,
  type WxField,
  api,
  bidCsv,
  bidRows,
  dayLabel,
  hhmm,
  localDay,
  mwh,
  num,
  pct,
  when,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Explain, PLAIN, PageHeader, Section, Stat, StatRow } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

const START_API = "uv run uvicorn app.main:app --port 8000";
const TITLE = "Заявка на завтра";
const LEAD = "24 часовых значения, которые станция отправляет до 08:00.";

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const energy = (share: number) => share * RATED_MW; // one hour at this power, MWh
const mwValue = (share: number) => num(share * RATED_MW, 1);

function utcLabel(offset: string): string {
  const h = Number(offset.slice(0, 3));
  return Number.isFinite(h) ? `UTC${h >= 0 ? "+" : "−"}${Math.abs(h)}` : "UTC+5";
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? "Сервис прогноза не отвечает." : `Ошибка ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : "Неизвестная ошибка.";
}

function Code({ children }: { children: string }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{children}</code>;
}

function ApiErrorAlert({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <p>
          Запустите сервис в папке проекта: <Code>{START_API}</Code>
        </p>
      </AlertDescription>
    </Alert>
  );
}

function ContentSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true" aria-label="Загрузка заявки">
      <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-28" />
            <Skeleton className="h-10 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="h-96 w-full rounded-xl" />
    </div>
  );
}

function BidSkeleton() {
  return (
    <div className="flex flex-col">
      <PageHeader title={TITLE} lead={LEAD} actions={<Skeleton className="h-8 w-64" />} />
      <ContentSkeleton />
    </div>
  );
}

/** Title + help; on phones the help sits under the title so its popover stays on screen. */
function Heading({ title, help, label }: { title: string; help: React.ReactNode; label?: string }) {
  return (
    <div className="flex flex-col items-start gap-1 sm:flex-row sm:items-center sm:gap-2">
      <h2 className="text-lg font-semibold">{title}</h2>
      <Explain label={label}>{help}</Explain>
    </div>
  );
}

const GRID = [0, 0.5, 1]; // share of rated power: 0, 2,5 and 5 MW

/** 24 planned hours as bars on a 0…rated scale; hover or tap shows the hour. */
function PlanBars({ rows, hot, onHot }: {
  rows: ForecastRow[];
  hot: number | null;
  onHot: (lead: number | null) => void;
}) {
  const peak = rows.reduce((a, b) => (b.power_farm > a.power_farm ? b : a));
  const labelled = hot ?? peak.lead_h;
  const hotRow = rows.find((r) => r.lead_h === hot) ?? null;
  const lo = Math.min(...rows.map((r) => r.power_farm));
  return (
    <figure className="flex flex-col gap-4">
      <div
        className="relative h-64 sm:h-80"
        role="img"
        aria-label={`План по часам: от ${mwValue(lo)} до ${mwValue(peak.power_farm)} МВт, пик в ${hhmm(peak.target_time_local)}`}
      >
        <div className="absolute inset-y-0 left-0 w-9" aria-hidden>
          {GRID.map((v) => (
            <span
              key={v}
              className="absolute right-2 translate-y-1/2 text-xs text-muted-foreground tabular-nums"
              style={{ bottom: `calc(${v * 100}% - ${v * 1.75}rem)` }}
            >
              {num(v * RATED_MW, v === 0.5 ? 1 : 0)}
            </span>
          ))}
        </div>
        <div className="absolute inset-y-0 right-0 left-9 pt-7" aria-hidden>
          <div className="relative h-full">
            {GRID.map((v) => (
              <div
                key={v}
                className={cn("absolute inset-x-0 border-t", v === 0 ? "border-foreground/25" : "border-border/60")}
                style={{ bottom: `${v * 100}%` }}
              />
            ))}
            <div
              className="absolute inset-0 grid grid-cols-24 items-end gap-0.5 sm:gap-1"
              onMouseLeave={() => onHot(null)}
            >
              {rows.map((r) => {
                const share = Math.min(Math.max(r.power_farm, 0), 1);
                return (
                  <div
                    key={r.lead_h}
                    className="relative flex h-full cursor-pointer items-end"
                    onMouseEnter={() => onHot(r.lead_h)}
                    onClick={() => onHot(hot === r.lead_h ? null : r.lead_h)}
                  >
                    <div
                      className={cn(
                        "w-full rounded-t-[4px] bg-primary transition-opacity duration-150 ease-out",
                        hot !== null && hot !== r.lead_h && "opacity-35",
                      )}
                      style={{ height: `max(${share * 100}%, 2px)` }}
                    />
                    {labelled === r.lead_h && (
                      <span
                        className="absolute left-1/2 -translate-x-1/2 text-xs font-medium whitespace-nowrap text-foreground tabular-nums"
                        style={{ bottom: `calc(${share * 100}% + 0.375rem)` }}
                      >
                        {mwValue(r.power_farm)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>
      <div className="ml-9 grid grid-cols-24 gap-0.5 text-xs text-muted-foreground tabular-nums sm:gap-1" aria-hidden>
        {rows.map((r, i) => (
          <span key={r.lead_h} className={cn("whitespace-nowrap", i % 6 !== 0 && "invisible", i % 3 === 0 && "sm:visible")}>
            {i % 3 === 0 ? hhmm(r.target_time_local) : ""}
          </span>
        ))}
      </div>
      <figcaption className="min-h-6 text-sm text-muted-foreground" aria-live="polite">
        {hotRow ? (
          <>
            <b className="font-semibold text-foreground">{hhmm(hotRow.target_time_local)}</b>
            {`: план ${mwh(energy(hotRow.power_farm), 2)}, коридор ${num(energy(hotRow.p10), 2)}–${num(energy(hotRow.p90), 2)} МВт·ч`}
          </>
        ) : (
          "Наведите или нажмите на столбец."
        )}
      </figcaption>
    </figure>
  );
}

function download(rows: ForecastRow[], operatingDay: string) {
  const name = `bid_${operatingDay}.csv`;
  const url = URL.createObjectURL(new Blob([bidCsv(rows)], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
  toast.success(`Скачан ${name}`);
}

function IssuePicker({ issues, value, onChange }: {
  issues: IssueListItem[];
  value: string;
  onChange: (date: string) => void;
}) {
  const label = (d: string) => dayLabel(addDays(d, 2));
  const items = Object.fromEntries(issues.map((i) => [i.issue_date, label(i.issue_date)]));
  const idx = issues.findIndex((i) => i.issue_date === value);
  const prev = idx > 0 ? issues[idx - 1].issue_date : null;
  const next = idx >= 0 && idx < issues.length - 1 ? issues[idx + 1].issue_date : null;
  return (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <Button variant="outline" size="icon-lg" aria-label="Предыдущие сутки" disabled={!prev}
        onClick={() => prev && onChange(prev)}>
        <ChevronLeft aria-hidden />
      </Button>
      <Select<string> items={items} value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger aria-label="Сутки заявки" className="h-9 min-w-0 flex-1 sm:w-44 sm:flex-none">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {issues.map((i) => (
            <SelectItem key={i.issue_date} value={i.issue_date}>
              {label(i.issue_date)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button variant="outline" size="icon-lg" aria-label="Следующие сутки" disabled={!next}
        onClick={() => next && onChange(next)}>
        <ChevronRight aria-hidden />
      </Button>
    </div>
  );
}

function BidView({ issue }: { issue: ForecastIssue }) {
  const [hot, setHot] = useState<number | null>(null);
  const rows = useMemo(() => bidRows(issue.rows), [issue]);

  if (rows.length === 0) {
    return (
      <Alert>
        <TriangleAlert aria-hidden />
        <AlertTitle>В этом выпуске нет заявки</AlertTitle>
        <AlertDescription>Выберите другие сутки.</AlertDescription>
      </Alert>
    );
  }

  const first = rows[0];
  const operatingDay = localDay(first.target_time_local);
  const gateDay = addDays(operatingDay, -1);
  const offset = first.target_time_local.slice(19) || "+05:00";
  const gateIso = `${gateDay}T08:00:00${offset}`;
  const hoursBeforeGate = Math.round((Date.parse(gateIso) - Date.parse(first.issue_time_local)) / 3_600_000);
  const onTime = hoursBeforeGate > 0;

  const total = rows.reduce((s, r) => s + energy(r.power_farm), 0);
  const totalP10 = rows.reduce((s, r) => s + energy(r.p10), 0);
  const totalP90 = rows.reduce((s, r) => s + energy(r.p90), 0);
  const meanShare = rows.reduce((s, r) => s + r.power_farm, 0) / rows.length;
  const peak = rows.reduce((a, b) => (b.power_farm > a.power_farm ? b : a));

  const wxCount = new Map<WxField, number>();
  for (const r of rows) wxCount.set(r.wx_field, (wxCount.get(r.wx_field) ?? 0) + 1);
  const fallbackRows = rows.filter((r) => r.fallback_used);
  const fallbackModels = [...new Set(fallbackRows.map((r) => MODEL_LABEL[r.model_name] ?? r.model_name))];

  const rev0ByLead = new Map(rows.map((r) => [r.lead_h, r]));
  const revised = issue.rows
    .filter((r) => r.revision > 0 && rev0ByLead.has(r.lead_h))
    .map((r) => {
      const base = rev0ByLead.get(r.lead_h) as ForecastRow;
      return { row: r, base, delta: energy(r.power_farm - base.power_farm) };
    });
  const biggest = revised.reduce<(typeof revised)[number] | null>(
    (a, b) => (a === null || Math.abs(b.delta) > Math.abs(a.delta) ? b : a),
    null,
  );

  const needsCheck = issue.warnings.length > 0 || fallbackRows.length > 0 || rows.length < 24;

  return (
    <div className="wc-step flex flex-col">
      {needsCheck && (
        <Alert className="mb-10">
          <TriangleAlert aria-hidden className="text-(--warn)" />
          <AlertTitle>Проверьте перед отправкой</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {rows.length < 24 && <li>Заполнено {rows.length} из 24 часов.</li>}
              {fallbackRows.length > 0 && (
                <li>{fallbackRows.length} ч посчитаны запасной моделью: {fallbackModels.join(", ")}.</li>
              )}
              {issue.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <StatRow>
        <Stat label="Энергия за сутки" value={num(total, 1)} unit="МВт·ч" />
        <Stat label="Средняя мощность" value={mwValue(meanShare)} unit="МВт" note={`${pct(meanShare)} от ${RATED_MW} МВт`} />
        <Stat label="Пик" value={mwValue(peak.power_farm)} unit="МВт" note={`в ${hhmm(peak.target_time_local)}`} />
        <Stat
          label="Отправить до"
          value="08:00"
          note={
            onTime ? (
              <span className="inline-flex items-center gap-1.5">
                <CircleCheck className="size-4 text-(--ok)" aria-hidden />
                {dayLabel(gateDay)}, в срок
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <TriangleAlert className="size-4 text-(--warn)" aria-hidden />
                {dayLabel(gateDay)}, выпуск опоздал
              </span>
            )
          }
        />
      </StatRow>

      <Card className="mt-12 gap-8 overflow-visible [--card-spacing:--spacing(5)] sm:[--card-spacing:--spacing(8)]">
        <CardContent className="flex flex-col gap-8">
          <div className="flex flex-wrap items-center justify-between gap-4">
            <Heading
              title="Мощность по часам, МВт"
              label="Почему так"
              help={
                <ul className="flex list-disc flex-col gap-2 pl-4">
                  <li>План на сутки отправляют до 08:00 накануне.</li>
                  <li>В план идёт середина прогноза: недобор и перебор штрафуют одинаково.</li>
                  <li>Отклонение в пределах ±5 % от плана часа не штрафуется.</li>
                  <li>Час можно поправить не позже чем за 2 часа до начала. Этим пользуется {PLAIN.recompute}.</li>
                </ul>
              }
            />
            <Button size="lg" className="px-4" onClick={() => download(rows, operatingDay)}>
              <Download aria-hidden />
              Скачать CSV
            </Button>
          </div>
          <PlanBars rows={rows} hot={hot} onHot={setHot} />
        </CardContent>
      </Card>

      <Section className="mt-12">
        <div className="max-w-2xl">
          <div className="mb-6">
            <Heading
              title="По часам"
              help={
                <ul className="flex list-disc flex-col gap-2 pl-4">
                  <li>План — сколько энергии станция обещает выдать за час.</li>
                  <li>Коридор: в 8 случаях из 10 факт окажется внутри.</li>
                </ul>
              }
            />
          </div>
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-0">Час</TableHead>
                <TableHead className="text-right">План, МВт·ч</TableHead>
                <TableHead className="pr-0 text-right">Коридор, МВт·ч</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow
                  key={r.lead_h}
                  className={cn(hot === r.lead_h && "bg-accent hover:bg-accent")}
                  onMouseEnter={() => setHot(r.lead_h)}
                  onMouseLeave={() => setHot(null)}
                >
                  <TableCell className="pl-0">{hhmm(r.target_time_local)}</TableCell>
                  <TableCell className="text-right font-medium">{num(energy(r.power_farm), 2)}</TableCell>
                  <TableCell className="pr-0 text-right text-muted-foreground">
                    {num(energy(r.p10), 2)}–{num(energy(r.p90), 2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell className="pl-0">За сутки</TableCell>
                <TableCell className="text-right">{num(total, 2)}</TableCell>
                <TableCell className="pr-0 text-right font-normal text-muted-foreground">
                  {num(totalP10, 1)}–{num(totalP90, 1)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>

          <details className="group/more mt-10">
            <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground hover:text-foreground [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-4 transition-transform duration-150 group-open/more:rotate-90" aria-hidden />
              Подробнее для экспертов
            </summary>
            <div className="mt-6 flex flex-col gap-8 text-sm">
              <dl className="grid gap-x-8 gap-y-4 sm:grid-cols-[max-content_1fr]">
                <dt className="text-muted-foreground">Выпуск</dt>
                <dd>
                  {when(first.issue_time_local)}
                  {onTime ? `, за ${hoursBeforeGate} ч до срока` : ", после срока подачи"}
                </dd>
                <dt className="text-muted-foreground">Модель</dt>
                <dd>{MODEL_LABEL[issue.model_name] ?? issue.model_name}, медиана (p50)</dd>
                <dt className="text-muted-foreground">Время</dt>
                <dd>Астана, {utcLabel(offset)}</dd>
                <dt className="text-muted-foreground">Коридор</dt>
                <dd>p10–p90; итог — сумма часовых границ, а не границы суточной энергии</dd>
                <dt className="text-muted-foreground">Погода</dt>
                <dd>{[...wxCount.entries()].map(([f, n]) => `${WX_FIELD_LABEL[f]}: ${n} ч`).join("; ")}</dd>
                <dt className="text-muted-foreground">Уточнение в 12:00</dt>
                <dd>
                  {revised.length > 0 && biggest
                    ? `${revised.length} из ${rows.length} ч; сильнее всего ${hhmm(biggest.row.target_time_local)}: ${num(energy(biggest.base.power_farm), 2)} → ${num(energy(biggest.row.power_farm), 2)} МВт·ч. `
                    : "часы заявки не менялись. "}
                  <Link href={`/issues?date=${issue.issue_date}`} className="font-medium text-primary underline underline-offset-3">
                    Открыть выпуск
                  </Link>
                </dd>
              </dl>
              <Table className="tabular-nums">
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-0">Час</TableHead>
                    <TableHead className="text-right">Ветер на 100 м, м/с</TableHead>
                    <TableHead className="pr-0">Прогон погоды</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rows.map((r) => (
                    <TableRow key={r.lead_h}>
                      <TableCell className="pl-0">{hhmm(r.target_time_local)}</TableCell>
                      <TableCell className="text-right">
                        {r.ws100_fc === null ? (
                          <>
                            <span aria-hidden>—</span>
                            <span className="sr-only">нет данных</span>
                          </>
                        ) : (
                          num(r.ws100_fc, 1)
                        )}
                      </TableCell>
                      <TableCell className="pr-0 text-muted-foreground">
                        {r.wx_field === "none" ? (
                          <span className="inline-flex items-center gap-1.5 text-foreground">
                            <TriangleAlert className="size-3.5 text-(--warn)" aria-hidden />
                            {WX_FIELD_LABEL[r.wx_field]}
                          </span>
                        ) : (
                          WX_FIELD_LABEL[r.wx_field]
                        )}
                        {r.fallback_used && `; запасная модель: ${MODEL_LABEL[r.model_name] ?? r.model_name}`}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </details>
        </div>
      </Section>
    </div>
  );
}

type Loaded = { date: string; issue?: ForecastIssue; error?: string };

function BidPage() {
  const router = useRouter();
  const params = useSearchParams();
  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState<Loaded | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .issues()
      .then((list) => alive && setIssues([...list].sort((a, b) => a.issue_date.localeCompare(b.issue_date))))
      .catch((e: unknown) => alive && setListError(errorText(e)));
    return () => {
      alive = false;
    };
  }, []);

  const date = params.get("date") ?? issues?.[0]?.issue_date ?? null;

  useEffect(() => {
    if (!date) return;
    let alive = true;
    api
      .forecast(date)
      .then((issue) => alive && setLoaded({ date, issue }))
      .catch((e: unknown) => alive && setLoaded({ date, error: errorText(e) }));
    return () => {
      alive = false;
    };
  }, [date]);

  const pick = (d: string) => router.replace(`/bid?date=${d}`, { scroll: false });
  const current = loaded && loaded.date === date ? loaded : null;

  if (listError) {
    return (
      <div className="flex flex-col">
        <PageHeader title={TITLE} lead={LEAD} />
        <ApiErrorAlert title="Нет связи с сервисом прогноза" message={listError} />
      </div>
    );
  }
  if (issues === null) return <BidSkeleton />;
  if (issues.length === 0) {
    return (
      <div className="flex flex-col">
        <PageHeader title={TITLE} lead={LEAD} />
        <Alert>
          <CircleAlert aria-hidden />
          <AlertTitle>Выпусков пока нет</AlertTitle>
          <AlertDescription>
            <p>
              Сделайте первый: <Code>uv run python -m app.cli forecast --issue 2026-01-31</Code>
            </p>
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <PageHeader
        title={TITLE}
        lead={LEAD}
        actions={date ? <IssuePicker issues={issues} value={date} onChange={pick} /> : undefined}
      />
      {current === null ? (
        <ContentSkeleton />
      ) : current.error || !current.issue ? (
        <ApiErrorAlert title={`Не удалось загрузить ${dayLabel(addDays(current.date, 2))}`}
          message={current.error ?? "Пустой ответ."} />
      ) : (
        <BidView key={current.date} issue={current.issue} />
      )}
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<BidSkeleton />}>
      <BidPage />
    </Suspense>
  );
}

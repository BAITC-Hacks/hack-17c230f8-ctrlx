"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, CircleAlert, Clock, Download, RefreshCw, TriangleAlert } from "lucide-react";
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
  mw,
  mwh,
  num,
  pct,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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

function addDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const energy = (share: number) => share * RATED_MW; // one hour at this power, MWh

const at = (iso: string) => `${dayLabel(iso)} в ${hhmm(iso)}`;

function utcLabel(offset: string): string {
  const h = Number(offset.slice(0, 3));
  return Number.isFinite(h) ? `UTC${h >= 0 ? "+" : "−"}${Math.abs(h)}` : "UTC+5";
}

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? "Сервис прогноза не отвечает." : `Ошибка ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : "Неизвестная ошибка.";
}

function ApiErrorAlert({ title, message }: { title: string; message: string }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden />
      <AlertTitle>{title}</AlertTitle>
      <AlertDescription>
        <p>{message}</p>
        <p>
          Если API не запущен, выполните в папке проекта:{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{START_API}</code>
        </p>
      </AlertDescription>
    </Alert>
  );
}

function BidSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Загрузка заявки">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="flex flex-col gap-2">
          <Skeleton className="h-8 w-72 max-w-full" />
          <Skeleton className="h-4 w-96 max-w-full" />
        </div>
        <Skeleton className="h-8 w-full md:w-80" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-[28rem] w-full rounded-xl" />
    </div>
  );
}

/** 24 planned hours as bars on a 0…rated scale; hover or tap shows the hour. */
function PlanSparkline({ rows, hot, onHot }: {
  rows: ForecastRow[];
  hot: number | null;
  onHot: (lead: number | null) => void;
}) {
  const COL = 10;
  const H = 80;
  const hotRow = rows.find((r) => r.lead_h === hot) ?? null;
  return (
    <figure className="flex flex-col gap-1">
      <figcaption className="flex flex-wrap justify-between gap-x-4 text-sm text-muted-foreground">
        <span>План по часам, МВт</span>
        <span>шкала до номинала {RATED_MW} МВт</span>
      </figcaption>
      <svg
        viewBox={`0 0 ${rows.length * COL} ${H}`}
        preserveAspectRatio="none"
        className="h-20 w-full"
        role="img"
        aria-label={`Почасовой план на сутки, от ${mw(Math.min(...rows.map((r) => r.power_farm)))} до ${mw(Math.max(...rows.map((r) => r.power_farm)))}`}
        onMouseLeave={() => onHot(null)}
      >
        <line x1={0} x2={rows.length * COL} y1={0.5} y2={0.5} className="stroke-border"
          strokeDasharray="4 4" vectorEffect="non-scaling-stroke" />
        {rows.map((r, i) => {
          const top = H * (1 - Math.min(Math.max(r.power_farm, 0), 1));
          return (
            <g key={r.lead_h}>
              <rect
                x={i * COL + 0.6}
                y={top}
                width={COL - 1.2}
                height={H - top + 3}
                rx={0.8}
                ry={3}
                className={cn("fill-primary", hot !== null && hot !== r.lead_h && "opacity-40")}
              />
              <rect
                x={i * COL}
                y={0}
                width={COL}
                height={H}
                fill="transparent"
                onMouseEnter={() => onHot(r.lead_h)}
                onClick={() => onHot(r.lead_h)}
              >
                <title>{`${hhmm(r.target_time_local)}: ${mw(r.power_farm)}`}</title>
              </rect>
            </g>
          );
        })}
        <line x1={0} x2={rows.length * COL} y1={H - 0.5} y2={H - 0.5} className="stroke-foreground/30"
          vectorEffect="non-scaling-stroke" />
      </svg>
      <div className="relative h-4 text-xs text-muted-foreground" aria-hidden>
        {rows.filter((_, i) => i % 6 === 0).map((r) => (
          <span key={r.lead_h} className="absolute" style={{ left: `${(rows.indexOf(r) / rows.length) * 100}%` }}>
            {hhmm(r.target_time_local)}
          </span>
        ))}
      </div>
      <p className="min-h-5 text-sm text-muted-foreground" aria-live="polite">
        {hotRow ? (
          <>
            <b className="font-medium text-foreground">{hhmm(hotRow.target_time_local)}</b>
            {`: план ${mwh(energy(hotRow.power_farm), 2)}, коридор p10–p90 ${num(energy(hotRow.p10), 2)}–${num(energy(hotRow.p90), 2)} МВт·ч`}
          </>
        ) : (
          "Наведите на столбец или строку таблицы, чтобы увидеть час."
        )}
      </p>
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
  toast.success(`Скачан файл ${name}`);
}

function IssuePicker({ issues, value, onChange }: {
  issues: IssueListItem[];
  value: string;
  onChange: (date: string) => void;
}) {
  const label = (d: string) => `${dayLabel(addDays(d, 2))} (выпуск за ${dayLabel(d)})`;
  const items = Object.fromEntries(issues.map((i) => [i.issue_date, label(i.issue_date)]));
  const idx = issues.findIndex((i) => i.issue_date === value);
  const prev = idx > 0 ? issues[idx - 1].issue_date : null;
  const next = idx >= 0 && idx < issues.length - 1 ? issues[idx + 1].issue_date : null;
  return (
    <div className="flex items-center gap-1.5">
      <Button variant="outline" size="icon" aria-label="Предыдущие сутки" disabled={!prev}
        onClick={() => prev && onChange(prev)}>
        <ChevronLeft aria-hidden />
      </Button>
      <Select<string> items={items} value={value} onValueChange={(v) => v && onChange(v)}>
        <SelectTrigger aria-label="Операционные сутки заявки" className="min-w-0 flex-1 md:w-72 md:flex-none">
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
      <Button variant="outline" size="icon" aria-label="Следующие сутки" disabled={!next}
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
        <AlertTitle>В этом выпуске нет часов суточной заявки</AlertTitle>
        <AlertDescription>
          Заявка берётся из часов 24–47 прогноза без пересчёта, а их здесь нет. Выберите другие сутки.
        </AlertDescription>
      </Alert>
    );
  }

  const first = rows[0];
  const operatingDay = localDay(first.target_time_local);
  const gateDay = addDays(operatingDay, -1);
  const offset = first.target_time_local.slice(19) || "+05:00";
  const gateIso = `${gateDay}T08:00:00${offset}`;
  const hoursBeforeGate = Math.round((Date.parse(gateIso) - Date.parse(first.issue_time_local)) / 3_600_000);

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

  return (
    <div className="wc-step flex flex-col gap-6">
      {(issue.warnings.length > 0 || fallbackRows.length > 0 || rows.length < 24) && (
        <Alert>
          <TriangleAlert aria-hidden className="text-(--warn)" />
          <AlertTitle>Проверьте заявку перед подачей</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {rows.length < 24 && <li>В заявке {rows.length} из 24 часов.</li>}
              {fallbackRows.length > 0 && (
                <li>
                  Для {fallbackRows.length} ч основная модель не сработала, использована запасная:{" "}
                  {fallbackModels.join(", ")}.
                </li>
              )}
              {issue.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
          <div className="flex flex-col gap-3 text-[15px] leading-relaxed">
            <p>
              Станция на возобновляемых источниках подаёт почасовой план на операционные сутки до 08:00
              предыдущих суток (правила оптового рынка, п. 51). Этот выпуск сделан {at(first.issue_time_local)}
              {hoursBeforeGate > 0 ? ` — за ${hoursBeforeGate} ч до срока.` : "."}
            </p>
            <p className="text-muted-foreground">
              В заявку идёт медиана прогноза ({MODEL_LABEL[issue.model_name] ?? issue.model_name}): коэффициенты
              дисбаланса 1,3 и 0,7 симметричны, недобор и перебор обходятся одинаково, поэтому медиана даёт
              наименьший ожидаемый штраф.
            </p>
            <p className="flex items-center gap-2 text-sm">
              {hoursBeforeGate > 0 ? (
                <>
                  <Clock className="size-4 text-(--ok)" aria-hidden />
                  <span>Подать до {dayLabel(gateDay)}, 08:00.</span>
                </>
              ) : (
                <>
                  <TriangleAlert className="size-4 text-(--warn)" aria-hidden />
                  <span>Выпуск сделан после срока подачи ({dayLabel(gateDay)}, 08:00): для заявки он опоздал.</span>
                </>
              )}
            </p>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-4 self-start">
            <div>
              <dt className="text-sm text-muted-foreground">Энергия за сутки</dt>
              <dd className="text-xl font-semibold tabular-nums">{mwh(total)}</dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground" title="Сумма часовых границ коридора; это не квантиль суточной энергии">
                Сумма часовых p10 и p90
              </dt>
              <dd className="text-xl font-semibold tabular-nums">
                {num(totalP10, 1)}–{num(totalP90, 1)} <span className="text-base font-normal">МВт·ч</span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Средняя мощность</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {mw(meanShare)}{" "}
                <span className="text-base font-normal text-muted-foreground">{pct(meanShare)} номинала</span>
              </dd>
            </div>
            <div>
              <dt className="text-sm text-muted-foreground">Пик</dt>
              <dd className="text-xl font-semibold tabular-nums">
                {mw(peak.power_farm)}{" "}
                <span className="text-base font-normal text-muted-foreground">в {hhmm(peak.target_time_local)}</span>
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-sm text-muted-foreground">Погода для заявки</dt>
              <dd className="text-sm">
                {[...wxCount.entries()].map(([f, n]) => `${WX_FIELD_LABEL[f]}: ${n} ч`).join("; ")}
              </dd>
            </div>
          </dl>
          <div className="lg:col-span-2">
            <PlanSparkline rows={rows} hot={hot} onHot={setHot} />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <CardTitle>Почасовой план на {dayLabel(operatingDay)}</CardTitle>
              <CardDescription>
                Энергия за каждый час в МВт·ч, время Астаны ({utcLabel(offset)}). p10 и p90 — границы, ниже которых
                выработка окажется с вероятностью 10 % и 90 %.
              </CardDescription>
            </div>
            <Button className="self-start" onClick={() => download(rows, operatingDay)}>
              <Download aria-hidden />
              Скачать CSV
            </Button>
          </div>
        </CardHeader>
        <CardContent className="px-0">
          <Table className="tabular-nums">
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Час (Астана)</TableHead>
                <TableHead className="text-right">План, МВт·ч</TableHead>
                <TableHead className="text-right">p10, МВт·ч</TableHead>
                <TableHead className="text-right">p90, МВт·ч</TableHead>
                <TableHead className="text-right">Ветер на 100 м, м/с</TableHead>
                <TableHead className="pr-4">Прогон погоды</TableHead>
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
                  <TableCell className="pl-4 font-medium">{hhmm(r.target_time_local)}</TableCell>
                  <TableCell className="text-right font-medium">{num(energy(r.power_farm), 2)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{num(energy(r.p10), 2)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">{num(energy(r.p90), 2)}</TableCell>
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
                  <TableCell className="pr-4">
                    {r.wx_field === "none" ? (
                      <span className="inline-flex items-center gap-1.5">
                        <TriangleAlert className="size-3.5 text-(--warn)" aria-hidden />
                        {WX_FIELD_LABEL[r.wx_field]}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">{WX_FIELD_LABEL[r.wx_field]}</span>
                    )}
                    {r.fallback_used && (
                      <span className="text-muted-foreground">
                        {`; запасная модель: ${MODEL_LABEL[r.model_name] ?? r.model_name}`}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell className="pl-4">Итого за сутки</TableCell>
                <TableCell className="text-right">{num(total, 2)}</TableCell>
                <TableCell className="text-right">{num(totalP10, 2)}</TableCell>
                <TableCell className="text-right">{num(totalP90, 2)}</TableCell>
                <TableCell />
                <TableCell className="pr-4 font-normal text-muted-foreground">{rows.length} ч</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
          <p className="px-4 pt-3 text-sm text-muted-foreground">
            Итоги p10 и p90 — суммы почасовых границ, а не границы суточной энергии. В файле bid_{operatingDay}.csv:
            час по Астане, план, p10 и p90 в МВт·ч, {rows.length} строк.
          </p>
        </CardContent>
      </Card>

      <Alert>
        <RefreshCw aria-hidden />
        <AlertTitle>Внутрисуточная корректировка</AlertTitle>
        <AlertDescription>
          <p>
            После подачи план можно уточнить не позднее чем за 2 часа до начала часа (п. 97–99). Пересчёт агента в
            12:00 по свежему прогону погоды — именно такая корректировка.{" "}
            {revised.length > 0 && biggest ? (
              <>
                В этом выпуске он пересчитал {revised.length} из {rows.length} ч заявки; сильнее всего изменился
                час {hhmm(biggest.row.target_time_local)}: с {mwh(energy(biggest.base.power_farm), 2)} до{" "}
                {mwh(energy(biggest.row.power_farm), 2)}.
              </>
            ) : (
              <>Для часов этой заявки пересчёта в выпуске не было.</>
            )}{" "}
            <Link href={`/issues?date=${issue.issue_date}`} className="font-medium text-primary underline underline-offset-3">
              Открыть выпуск
            </Link>
          </p>
        </AlertDescription>
      </Alert>
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
  const bid = current?.issue ? bidRows(current.issue.rows) : [];
  const operatingDay = bid.length > 0 ? localDay(bid[0].target_time_local) : null;

  if (listError) return <ApiErrorAlert title="Не удалось загрузить список выпусков" message={listError} />;
  if (issues === null) return <BidSkeleton />;
  if (issues.length === 0) {
    return (
      <Alert>
        <CircleAlert aria-hidden />
        <AlertTitle>Выпусков пока нет</AlertTitle>
        <AlertDescription>
          Суточная заявка появится после первого выпуска прогноза. Сделайте его командой{" "}
          <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">
            uv run python -m app.cli forecast --issue 2026-01-31
          </code>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            Суточная заявка{operatingDay ? ` на ${dayLabel(operatingDay)}` : ""}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {current?.issue && operatingDay
              ? `План из выпуска за ${dayLabel(current.issue.issue_date)}, версия до пересчёта в 12:00.`
              : "Почасовой план выработки ВЭС на операционные сутки."}
          </p>
        </div>
        {date && <IssuePicker issues={issues} value={date} onChange={pick} />}
      </div>

      {current === null ? (
        <div className="flex flex-col gap-6" aria-busy="true" aria-label="Загрузка заявки">
          <Skeleton className="h-64 w-full rounded-xl" />
          <Skeleton className="h-[28rem] w-full rounded-xl" />
        </div>
      ) : current.error || !current.issue ? (
        <ApiErrorAlert title={`Не удалось загрузить выпуск за ${dayLabel(current.date)}`}
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

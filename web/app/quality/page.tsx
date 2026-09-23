"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleQuestionMark,
  CircleX,
  Info,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { Bars } from "@/components/charts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  MODEL_LABEL,
  RATED_MW,
  api,
  dayLabel,
  mw,
  num,
  type Evidence,
  type FaultsEvidence,
  type MetricRow,
  type MetricsReport,
  type ReplayEvidence,
} from "@/lib/api";
import { cn } from "@/lib/utils";

// ---- formatting ------------------------------------------------------------------------------

const MONTHS = ["январь", "февраль", "март", "апрель", "май", "июнь", "июль", "август", "сентябрь",
  "октябрь", "ноябрь", "декабрь"];
const MINUS = "−";
const START_API = "uv run uvicorn app.main:app --port 8000";

function periodLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${MONTHS[m - 1]} ${y}` : period;
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fullDate = (iso: string) => `${dayLabel(iso)} ${iso.slice(0, 4)}`;
const modelName = (m: string) => MODEL_LABEL[m] ?? m;

function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}
// n counts (issue, hour) pairs: every hour appears in two issues (as D+1 and as D+2)
const hours = (n: number) =>
  `${num(n, 0)} ${plural(n, ["пара", "пары", "пар"])} «выпуск × час»`;
const ofHours = (n: number) => `${n} ${plural(n, ["часа", "часов", "часов"])}`;

function signed(value: number, digits: number, unit: string): string {
  const abs = num(Math.abs(value), digits);
  const sign = abs === num(0, digits) ? "" : value < 0 ? MINUS : "+";
  return `${sign}${abs} ${unit}`;
}
/** Error in share of rated power → signed MW. */
const signedMw = (share: number, digits = 2) => signed(share * RATED_MW, digits, "МВт");
/** Share 0..1 → "84 %", negatives with a real minus sign. */
const share = (x: number, digits = 0) => `${x < 0 ? MINUS : ""}${num(Math.abs(x) * 100, digits)} %`;

type Rule = [RegExp, (m: RegExpMatchArray) => string];
function translate(text: string, rules: Rule[]): string {
  for (const [re, fn] of rules) {
    const m = text.trim().match(re);
    if (m) return fn(m);
  }
  return text;
}
const ru = (n: string) => n.replace(".", ",");

// The API speaks English; numbers inside the phrases are kept as the API sent them.
const DECISION_RULES: Rule[] = [
  [/^main model vs fallback/i, () => "Основная модель (бустинг) вместо запасной (кривая мощности)"],
  [/^recompute at t0\+12/i, () => "Пересчёт в 12:00 по свежему прогону погоды"],
  [/^fallback to a simpler model/i, () => "Переход на более простую модель после проваленной проверки"],
  [/^switch the weather source/i, () => "Смена источника погоды после проваленной проверки"],
  [/^drift flag/i, () => "Флаг дрейфа по самопроверке: рекомендовать переобучение, ничего не менять молча"],
];

const CASE_RULES: Rule[] = [
  [/^(\d+) hours of wind missing in the primary source$/i, (m) => `В основном источнике пропали ${m[1]} ч ветра`],
  [/^wind spike (\d+) m\/s only in the freshest run/i, (m) => `Выброс ветра ${m[1]} м/с только в самом свежем прогоне`],
  [/^wind spike (\d+) m\/s in the primary source$/i, (m) => `Выброс ветра ${m[1]} м/с в основном источнике`],
  [/^primary source unavailable$/i, () => "Основной источник погоды недоступен"],
  [/^both sources broken$/i, () => "Оба источника погоды сломаны"],
];

const AGENT_DECISION_RULES: Rule[] = [
  [/^switch\s*→\s*(.+)$/i, (m) => `переключился на запасной источник ${m[1]}`],
  [/^older_run$/i, () => "взял более старый прогон того же источника"],
  [/^climatology$/i, () => "перешёл на климатологию: прогноз без погоды"],
];

const ASSUMPTION_RULES: Rule[] = [
  [/^bid hours \(lead (\d+)-(\d+)\)$/i, (m) => `только часы суточной заявки (упреждение ${m[1]}–${m[2]} ч)`],
  [/^([\d.]+) MW$/i, (m) => `мощность ${ru(m[1])} МВт`],
  [/^([\d.]+) tg\/kWh$/i, (m) => `цена ${ru(m[1])} ₸/кВт·ч`],
  [/^penalty ([\d.]+) x price for every kWh \(all hours outside \+-(\d+) %\)$/i,
    (m) => `штраф ${ru(m[1])} × цена за каждый кВт·ч отклонения во всех часах вне ±${m[2]} %`],
  [/^new-contract regime$/i, () => "режим новых договоров"],
];

const VARIANTS: Record<string, { label: string; hint: string }> = {
  A: { label: "Персистентность", hint: "среднее за последние 24 часа" },
  B: { label: "Фиксированный конвейер: кривая мощности", hint: "без проверок входа и без пересчёта" },
  C: { label: "Только модель", hint: "градиентный бустинг в момент выпуска, без пересчёта" },
  D: { label: "Агент: опубликованный план", hint: "сутки D+1 пересчитаны в 12:00, сутки D+2 — заявка в момент выпуска" },
};
const variantKey = (variant: string) => (variant[1] === " " ? variant[0].toUpperCase() : "");

const MODEL_ORDER = ["persistence", "climatology", "power_curve", "gbm"];
const byModel = (a: string, b: string) => {
  const i = (m: string) => (MODEL_ORDER.includes(m) ? MODEL_ORDER.indexOf(m) : MODEL_ORDER.length);
  return i(a) - i(b);
};

const HORIZONS = [
  { key: "all", tab: "Все часы", phrase: "все 48 часов" },
  { key: "24h", tab: "Сутки D+1", phrase: "сутки D+1" },
  { key: "48h", tab: "Сутки D+2", phrase: "сутки D+2" },
] as const;
type HorizonKey = (typeof HORIZONS)[number]["key"];
const isHorizon = (v: string | null): v is HorizonKey => HORIZONS.some((h) => h.key === v);

// ---- small building blocks -------------------------------------------------------------------

type Tone = "ok" | "warn" | "bad" | "muted" | "unknown";
const TONE_ICON = { ok: CircleCheck, warn: TriangleAlert, bad: CircleX, muted: CircleMinus, unknown: CircleQuestionMark };
const TONE_COLOR = {
  ok: "text-(--ok)",
  warn: "text-(--warn)",
  bad: "text-destructive",
  muted: "text-muted-foreground",
  unknown: "text-(--warn)",
};

function Status({ tone, children, className }: { tone: Tone; children: ReactNode; className?: string }) {
  const Icon = TONE_ICON[tone];
  return (
    <span className={cn("inline-flex items-start gap-1.5", className)}>
      <Icon className={cn("mt-0.5 size-4 shrink-0", TONE_COLOR[tone])} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

function Section({ title, description, aside, children }: {
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          {aside}
        </div>
        {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

type Failure = { status: number; message: string };
type Result<T> = { ok: true; data: T } | { ok: false; error: Failure };

function failure(reason: unknown): Failure {
  if (reason instanceof ApiError) return { status: reason.status, message: reason.message };
  return { status: -1, message: reason instanceof Error ? reason.message : "неизвестная ошибка" };
}

function LoadError({ what, error, onRetry }: { what: string; error: Failure; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>Не удалось загрузить {what}</AlertTitle>
      <AlertDescription>
        <p>
          {error.status === 0
            ? "Сервис прогноза не отвечает."
            : `Сервис ответил ошибкой${error.status > 0 ? ` ${error.status}` : ""}: ${error.message}`}
        </p>
        <p>
          Запустите его из корня проекта: <code className="rounded bg-muted px-1 py-0.5 text-foreground">{START_API}</code>
        </p>
      </AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" onClick={onRetry}>
          <RotateCw data-icon="inline-start" aria-hidden />
          Повторить
        </Button>
      </AlertAction>
    </Alert>
  );
}

function Empty({ children, command }: { children: ReactNode; command: string }) {
  return (
    <p className="text-sm text-muted-foreground">
      {children} Их считает команда <code className="rounded bg-muted px-1 py-0.5 text-foreground">{command}</code>.
    </p>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Загружаем метрики">
      <div className="flex flex-col gap-2">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-4 w-full max-w-xl" />
      </div>
      <Skeleton className="h-[420px] w-full rounded-xl" />
      <Skeleton className="h-[320px] w-full rounded-xl" />
      <Skeleton className="h-[240px] w-full rounded-xl" />
    </div>
  );
}

// ---- section 1: validation on months with known facts --------------------------------------

function AccuracyTile({ row, phrase }: { row: MetricRow; phrase: string }) {
  return (
    <div className="rounded-lg border bg-background/50 p-4">
      <div className="text-sm text-muted-foreground">Точность основной модели, {phrase}</div>
      <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="text-3xl font-semibold tracking-tight">{num(100 - row.nmae, 2)} %</span>
        <span className="text-sm text-muted-foreground">
          точность = 1 − nMAE = 1 − {num(row.nmae, 2)} %
        </span>
      </div>
      <p className="mt-2 text-sm text-muted-foreground">
        nMAE — средняя абсолютная ошибка в процентах от номинала {RATED_MW} МВт. В среднем прогноз ошибается
        на {mw(row.mae, 2)} в час.
      </p>
    </div>
  );
}

function CoverageTile({ coverage, width }: { coverage: number; width: number }) {
  const target = 0.8;
  return (
    <div className="rounded-lg border bg-background/50 p-4">
      <div className="text-sm text-muted-foreground">Коридор p10–p90 основной модели, все часы</div>
      <div className="mt-1 text-3xl font-semibold tracking-tight">{share(coverage)}</div>
      <div className="relative mt-3 h-2 rounded-sm bg-muted" aria-hidden>
        <div className="h-full rounded-sm bg-primary" style={{ width: `${Math.min(coverage, 1) * 100}%` }} />
        <div className="absolute -top-1 h-4 w-0.5 rounded-full bg-foreground" style={{ left: `${target * 100}%` }} />
      </div>
      <div className="relative mt-1 h-4 text-xs text-muted-foreground" aria-hidden>
        <span className="absolute -translate-x-1/2 whitespace-nowrap" style={{ left: `${target * 100}%` }}>
          цель {share(target)}
        </span>
      </div>
      <p className="mt-2 text-sm">
        <Status tone={coverage >= target ? "ok" : "warn"}>
          Коридор накрыл {share(coverage)} часов при цели {share(target)}
          {coverage >= target ? " — с небольшим запасом." : " — факт чаще выходит за границы, чем нужно."}
        </Status>
      </p>
      <p className="mt-1 text-sm text-muted-foreground">Средняя ширина коридора — {mw(width)}.</p>
    </div>
  );
}

function MetricsTable({ rows }: { rows: MetricRow[] }) {
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Модель</TableHead>
            <TableHead className="text-right">MAE</TableHead>
            <TableHead className="text-right">RMSE</TableHead>
            <TableHead className="text-right">nMAE</TableHead>
            <TableHead className="text-right">Смещение</TableHead>
            <TableHead className="text-right">Выигрыш к персистентности</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r) => {
            const main = r.model === "gbm";
            return (
              <TableRow key={r.model} className={main ? "bg-accent/50 hover:bg-accent/70" : undefined}>
                <TableCell className={main ? "font-medium" : undefined}>
                  <span className="inline-flex items-center gap-2">
                    {cap(modelName(r.model))}
                    {main && <Badge variant="outline">основная</Badge>}
                  </span>
                </TableCell>
                <TableCell className="text-right tabular-nums">{mw(r.mae, 2)}</TableCell>
                <TableCell className="text-right tabular-nums">{mw(r.rmse, 2)}</TableCell>
                <TableCell className="text-right tabular-nums">{num(r.nmae, 2)} %</TableCell>
                <TableCell className="text-right tabular-nums">{signedMw(r.bias)}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {r.model === "persistence" ? (
                    <span className="text-muted-foreground">база сравнения</span>
                  ) : r.skill_vs_persistence === null ? (
                    "—"
                  ) : (
                    share(r.skill_vs_persistence)
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
        MAE и RMSE — средняя и среднеквадратичная ошибка за час. Смещение — среднее «прогноз − факт»: плюс —
        прогноз завышает, минус — занижает. Выигрыш — на сколько процентов MAE меньше, чем у персистентности
        (прогноз «как было последние 24 часа»).
      </p>
    </>
  );
}

function ReportView({ report, horizon, onHorizon }: {
  report: MetricsReport;
  horizon: HorizonKey;
  onHorizon: (h: HorizonKey) => void;
}) {
  const issues = typeof report.extras.issues === "number" ? report.extras.issues : null;
  const interval = report.extras.interval_p10_p90;
  return (
    <Tabs
      value={horizon}
      onValueChange={(v) => {
        const key = String(v);
        if (isHorizon(key)) onHorizon(key);
      }}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">
          Модель обучена на данных до {fullDate(report.train_end)}.
          {issues !== null && ` В проверке ${issues} ${plural(issues, ["выпуск", "выпуска", "выпусков"])}.`}
        </p>
        <TabsList aria-label="Какие часы прогноза считать">
          {HORIZONS.map((h) => (
            <TabsTrigger key={h.key} value={h.key} className="px-3">{h.tab}</TabsTrigger>
          ))}
        </TabsList>
      </div>
      {HORIZONS.map((h) => {
        const rows = report.rows.filter((r) => r.horizon === h.key).sort((a, b) => byModel(a.model, b.model));
        const main = rows.find((r) => r.model === "gbm");
        return (
          <TabsContent key={h.key} value={h.key} className="mt-3 flex flex-col gap-4">
            {(main || interval) && (
              <div className="grid gap-3 md:grid-cols-2">
                {main && <AccuracyTile row={main} phrase={h.phrase} />}
                {interval && <CoverageTile coverage={interval.coverage} width={interval.mean_width} />}
              </div>
            )}
            {rows.length ? (
              <div>
                <h3 className="text-sm font-medium">
                  Ошибки по моделям, {h.phrase}
                  {main && <span className="font-normal text-muted-foreground">: {hours(main.n)} с известным фактом</span>}
                </h3>
                <div className="mt-2">
                  <MetricsTable rows={rows} />
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">Для этого горизонта метрик нет.</p>
            )}
          </TabsContent>
        );
      })}
    </Tabs>
  );
}

function Validation({ reports, period, horizon, onPeriod, onHorizon }: {
  reports: MetricsReport[];
  period: string;
  horizon: HorizonKey;
  onPeriod: (p: string) => void;
  onHorizon: (h: HorizonKey) => void;
}) {
  return (
    <Section
      title="Проверка на месяцах, где факт известен"
      description="Каждый выпуск месяца повторён так, как будто он делается в тот день: только прогнозы погоды, доступные на момент выпуска. Потом прогноз сравнивается с фактом выработки."
    >
      <Tabs value={period} onValueChange={(v) => onPeriod(String(v))}>
        <TabsList aria-label="Месяц проверки">
          {reports.map((r) => (
            <TabsTrigger key={r.period} value={r.period} className="px-3">{cap(periodLabel(r.period))}</TabsTrigger>
          ))}
        </TabsList>
        {reports.map((r) => (
          <TabsContent key={r.period} value={r.period} className="mt-3">
            <ReportView report={r} horizon={horizon} onHorizon={onHorizon} />
          </TabsContent>
        ))}
      </Tabs>
      <Alert className="mt-6 bg-accent/40">
        <Info />
        <AlertTitle>Это проверка, а не независимый тест</AlertTitle>
        <AlertDescription>
          Январь 2026 и февраль 2025 мы тоже использовали, когда выбирали модель, признаки и правила агента, поэтому
          цифры выше могут быть немного оптимистичны. Февраль 2026 — тестовый месяц: его с фактом сравнивают организаторы.
        </AlertDescription>
      </Alert>
    </Section>
  );
}

// ---- section 2: what the agent adds -------------------------------------------------------

function versus(agent: number, other: number, name: string): string {
  const gain = 1 - agent / other;
  const digits = Math.abs(gain) < 0.05 ? 1 : 0;
  if (gain > 0) return `на ${share(gain, digits)} меньше, чем у ${name}`;
  if (gain < 0) return `на ${share(-gain, digits)} больше, чем у ${name}`;
  return `такая же, как у ${name}`;
}

function intervalTone(ci: [number, number]): { tone: Tone; text: string } {
  const [lo, hi] = ci;
  if (hi < 0) return { tone: "ok", text: "снижает ошибку" };
  if (lo > 0) return { tone: "bad", text: "увеличивает ошибку" };
  return { tone: "unknown", text: "не доказано на одном месяце" };
}

function AgentValue({ replay }: { replay: ReplayEvidence }) {
  const items = replay.ablation.map((a) => ({
    key: variantKey(a.variant),
    label: VARIANTS[variantKey(a.variant)]?.label ?? a.variant,
    value: a.mae,
  }));
  const agentIdx = items.findIndex((i) => i.key === "D");
  const find = (k: string) => items.find((i) => i.key === k)?.value;
  const [A, B, C, D] = [find("A"), find("B"), find("C"), find("D")];
  const compare = [
    B !== undefined && D !== undefined ? versus(D, B, "фиксированного конвейера") : null,
    A !== undefined && D !== undefined ? versus(D, A, "персистентности") : null,
  ].filter((s): s is string => s !== null);

  return (
    <Section
      title="Что даёт агент"
      description={`${cap(periodLabel(replay.month))} прожит заново, выпуск за выпуском: ${replay.issues} ${plural(replay.issues, ["выпуск", "выпуска", "выпусков"])}, ${hours(replay.rows_scored)} с известным фактом. Один и тот же месяц, четыре способа сделать прогноз.`}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div>
          <h3 className="text-sm font-medium">
            Средняя ошибка MAE за час <span className="font-normal text-muted-foreground">— меньше лучше</span>
          </h3>
          <div className="mt-3">
            <Bars items={items} highlight={agentIdx >= 0 ? agentIdx : undefined} format={(v) => mw(v, 2)} />
          </div>
          {compare.length > 0 && (
            <p className="mt-4 text-sm">Ошибка плана агента {compare.join(", и ")}.</p>
          )}
          {C !== undefined && D !== undefined && (
            <p className="mt-1 text-sm text-muted-foreground">
              {D < C
                ? `Против одной модели без пересчёта выигрыш небольшой — ${share(1 - D / C, 1)}: это вклад пересчёта в 12:00.`
                : "Пересчёт в 12:00 в этом месяце ошибку не уменьшил."}
            </p>
          )}
        </div>
        <dl className="flex flex-col gap-2 text-sm">
          {items.map((i) => (
            <div key={i.label}>
              <dt className={i.key === "D" ? "font-medium text-primary" : "font-medium"}>{i.label}</dt>
              {VARIANTS[i.key] && <dd className="text-muted-foreground">{VARIANTS[i.key].hint}</dd>}
            </div>
          ))}
        </dl>
      </div>

      <div className="mt-8">
        <h3 className="text-sm font-medium">Журнал решений агента</h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Насколько каждое решение изменило ошибку по сравнению с прогнозом без него. Минус — ошибка стала меньше.
        </p>
        <div className="mt-2">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Решение</TableHead>
                <TableHead className="text-right">Сработало</TableHead>
                <TableHead className="text-right">Эффект на MAE</TableHead>
                <TableHead>95 % интервал</TableHead>
                <TableHead className="text-right">В плюс</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {replay.decisions.map((d) => {
                const verdict = d.ci95 ? intervalTone(d.ci95) : null;
                return (
                  <TableRow key={d.decision} className="align-top">
                    <TableCell className="min-w-64 whitespace-normal" title={d.decision}>
                      {translate(d.decision, DECISION_RULES)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.fired} из {replay.issues}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.fired === 0 || d.mean_delta_mae === null ? (
                        <Status tone="muted" className="text-muted-foreground">не срабатывало</Status>
                      ) : (
                        signedMw(d.mean_delta_mae)
                      )}
                    </TableCell>
                    <TableCell className="min-w-48 whitespace-normal">
                      {d.ci95 && verdict ? (
                        <div className="flex flex-col gap-0.5">
                          <span className="tabular-nums">
                            от {signedMw(d.ci95[0])} до {signedMw(d.ci95[1])}
                          </span>
                          <Status tone={verdict.tone} className="text-muted-foreground">{verdict.text}</Status>
                        </div>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {d.wins !== undefined && d.fired > 0 ? `${d.wins} из ${d.fired}` : "—"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">
          «Сработало» — в скольких выпусках месяца решение было принято. «В плюс» — в скольких из них ошибка
          после решения стала меньше. Если 95 % интервал захватывает ноль, одного месяца мало, чтобы утверждать
          пользу.
        </p>
      </div>
    </Section>
  );
}

// ---- section 3: broken inputs -------------------------------------------------------------

function Faults({ faults }: { faults: FaultsEvidence }) {
  const H = "horizon_h" in faults && typeof faults.horizon_h === "number" ? faults.horizon_h : 48;
  const n = faults.cases.length;
  const agentFull = faults.cases.filter((c) => c.agent.valid_hours === H && !c.agent.error).length;
  const fixedClean = faults.cases.filter(
    (c) => c.fixed_pipeline.valid_hours === H && !(c.fixed_pipeline.hours_from_broken_input ?? 0) && !c.fixed_pipeline.error,
  ).length;

  return (
    <Section
      title="Сбои входных данных"
      description={`Выпуск ${fullDate(faults.issue)}, горизонт ${H} ч. Входную погоду портим намеренно и смотрим, что выдаст агент и что — фиксированный конвейер без проверок.`}
    >
      <p className="text-sm">
        Агент выдал все {H} ч в {agentFull} из {n} случаев. Фиксированный конвейер —{" "}
        {fixedClean === 0 ? "ни в одном" : `в ${fixedClean} из ${n}`}
        {fixedClean < n ? ": часы пропадают или считаются по битой погоде." : "."}
      </p>
      <div className="mt-3">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Что сломали</TableHead>
              <TableHead>Агент</TableHead>
              <TableHead>Фиксированный конвейер</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {faults.cases.map((c) => {
              const a = c.agent;
              const f = c.fixed_pipeline;
              const broken = f.hours_from_broken_input ?? 0;
              const aTone: Tone = a.error || a.valid_hours === 0 ? "bad" : a.valid_hours < H ? "warn" : "ok";
              const fTone: Tone = f.error || f.valid_hours < H ? "bad" : broken > 0 ? "warn" : "ok";
              return (
                <TableRow key={c.case} className="align-top">
                  <TableCell className="min-w-44 whitespace-normal font-medium" title={c.case}>
                    {translate(c.case, CASE_RULES)}
                  </TableCell>
                  <TableCell className="min-w-60 whitespace-normal">
                    <div className="flex flex-col gap-0.5">
                      <Status tone={aTone}>{a.valid_hours} из {ofHours(H)}</Status>
                      {a.decision && <span>Решение: {translate(a.decision, AGENT_DECISION_RULES)}</span>}
                      {a.model && <span className="text-muted-foreground">Модель: {modelName(a.model)}</span>}
                      {a.reason && <span className="text-muted-foreground">Почему: {a.reason}</span>}
                      {a.error && <span className="text-destructive">Ошибка: {a.error}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-52 whitespace-normal">
                    <div className="flex flex-col gap-0.5">
                      <Status tone={fTone}>{f.valid_hours} из {ofHours(H)}</Status>
                      {f.valid_hours === 0 && <span className="text-muted-foreground">прогноза нет</span>}
                      {f.valid_hours > 0 && f.valid_hours < H && (
                        <span className="text-muted-foreground">{H - f.valid_hours} ч без прогноза</span>
                      )}
                      {broken > 0 && <span>из них {broken} ч по битому входу</span>}
                      {f.error && <span className="text-destructive">Ошибка: {f.error}</span>}
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </Section>
  );
}

// ---- section 4: money ------------------------------------------------------------------------

function Money({ report }: { report: MetricsReport }) {
  const cost = report.extras.imbalance_cost_upper_bound_mln_tg;
  const rows = cost
    ? Object.entries(cost)
        .filter((e): e is [string, number] => typeof e[1] === "number")
        .sort((a, b) => byModel(a[0], b[0]))
    : [];
  const base = rows.find(([m]) => m === "persistence")?.[1];
  const assumptions = typeof cost?.assumptions === "string"
    ? cost.assumptions.split(/,\s*/).map((p) => translate(p, ASSUMPTION_RULES)).join("; ")
    : null;

  return (
    <Section
      title="Во что это в тенге"
      aside={<Badge variant="outline">верхняя оценка</Badge>}
      description={`Штраф за небаланс за ${periodLabel(report.period)}, если бы суточную заявку подавали по прогнозу каждой модели.`}
    >
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Для {periodLabel(report.period)} оценки в тенге нет.</p>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Модель</TableHead>
                <TableHead className="text-right">Штраф за месяц</TableHead>
                <TableHead className="text-right">Меньше, чем у персистентности</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map(([m, v]) => (
                <TableRow key={m} className={m === "gbm" ? "bg-accent/50 hover:bg-accent/70" : undefined}>
                  <TableCell className={m === "gbm" ? "font-medium" : undefined}>{cap(modelName(m))}</TableCell>
                  <TableCell className="text-right tabular-nums">{num(v, 2)} млн ₸</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {m === "persistence" ? (
                      <span className="text-muted-foreground">база сравнения</span>
                    ) : base === undefined ? (
                      "—"
                    ) : (
                      signed(base - v, 2, "млн ₸")
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <div className="flex flex-col gap-2 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Это сценарий сверху.</span> Штраф берётся с каждого
              кВт·ч отклонения, а не только с части сверх допуска. Реальная сумма зависит от договора и правил
              рынка.
            </p>
            {assumptions && <p>Допущения: {assumptions}.</p>}
          </div>
        </div>
      )}
    </Section>
  );
}

// ---- page ------------------------------------------------------------------------------------

type Loaded = { metrics: Result<MetricsReport[]>; evidence: Result<Evidence> };

function Quality() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [state, setState] = useState<Loaded | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let alive = true;
    Promise.allSettled([api.metrics(), api.evidence()]).then(([m, e]) => {
      if (!alive) return;
      setState({
        metrics: m.status === "fulfilled" ? { ok: true, data: m.value } : { ok: false, error: failure(m.reason) },
        evidence: e.status === "fulfilled" ? { ok: true, data: e.value } : { ok: false, error: failure(e.reason) },
      });
    });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const retry = () => {
    setState(null);
    setAttempt((a) => a + 1);
  };
  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set(key, value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  if (!state) return <PageSkeleton />;

  const reports = state.metrics.ok ? state.metrics.data : [];
  const wanted = params.get("period");
  const report =
    reports.find((r) => r.period === wanted) ?? reports.find((r) => r.period === "2026-01") ?? reports[0];
  const h = params.get("h");
  const horizon: HorizonKey = isHorizon(h) ? h : "all";
  const evidence = state.evidence;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Точность прогноза</h1>
        <p className="max-w-3xl text-muted-foreground">
          Насколько прогноз совпадает с фактом выработки там, где факт уже известен, что добавляет агент и сколько
          это стоит в тенге. Ошибки — в МВт при номинале станции {RATED_MW} МВт.
        </p>
      </header>

      {!state.metrics.ok ? (
        <LoadError what="метрики точности" error={state.metrics.error} onRetry={retry} />
      ) : !report ? (
        <Section title="Проверка на месяцах, где факт известен">
          <Empty command="uv run python -m app.cli evaluate">Метрик пока нет.</Empty>
        </Section>
      ) : (
        <Validation
          reports={reports}
          period={report.period}
          horizon={horizon}
          onPeriod={(p) => setParam("period", p)}
          onHorizon={(v) => setParam("h", v)}
        />
      )}

      {!evidence.ok ? (
        state.metrics.ok && <LoadError what="данные о работе агента" error={evidence.error} onRetry={retry} />
      ) : (
        <>
          {evidence.data.replay ? (
            <AgentValue replay={evidence.data.replay} />
          ) : (
            <Section title="Что даёт агент">
              <Empty command="uv run python -m app.cli replay">Прогона месяца с известным фактом пока нет.</Empty>
            </Section>
          )}
          {evidence.data.faults ? (
            <Faults faults={evidence.data.faults} />
          ) : (
            <Section title="Сбои входных данных">
              <Empty command="uv run python -m app.cli faults">Проверки на битых данных пока нет.</Empty>
            </Section>
          )}
        </>
      )}

      {report && <Money report={report} />}
    </div>
  );
}

export default function QualityPage() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <Quality />
    </Suspense>
  );
}

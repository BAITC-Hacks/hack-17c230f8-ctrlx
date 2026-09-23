"use client";

import { Suspense, useEffect, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CircleQuestionMark,
  CircleX,
  RotateCw,
  TriangleAlert,
} from "lucide-react";
import { Bars } from "@/components/charts";
import { Explain, PageHeader, Section, Stat, StatRow } from "@/components/kit";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
const MONTHS_IN = ["январе", "феврале", "марте", "апреле", "мае", "июне", "июле", "августе", "сентябре",
  "октябре", "ноябре", "декабре"];
const MINUS = "−";
const START_API = "uv run uvicorn app.main:app --port 8000";
const COVERAGE_TARGET = 0.8;

function monthOf(period: string, names: string[]): string {
  const [y, m] = period.split("-").map(Number);
  return m >= 1 && m <= 12 ? `${names[m - 1]} ${y}` : period;
}
const periodLabel = (p: string) => monthOf(p, MONTHS);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const fullDate = (iso: string) => `${dayLabel(iso)} ${iso.slice(0, 4)}`;

function plural(n: number, forms: [string, string, string]): string {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b === 1) return forms[0];
  if (b >= 2 && b <= 4) return forms[1];
  return forms[2];
}

function signed(value: number, digits: number, unit: string): string {
  const abs = num(Math.abs(value), digits);
  const sign = abs === num(0, digits) ? "" : value < 0 ? MINUS : "+";
  return `${sign}${abs} ${unit}`;
}
/** Error in share of rated power → signed MW. */
const signedMw = (share: number, digits = 2) => signed(share * RATED_MW, digits, "МВт");
/** Share 0..1 → "84 %", negatives with a real minus sign. */
const share = (x: number, digits = 0) => `${x < 0 ? MINUS : ""}${num(Math.abs(x) * 100, digits)} %`;

/** "в 2 раза", "в 1,9 раза", "в 5 раз". */
function times(ratio: number): string {
  const rounded = Math.round(ratio * 10) / 10;
  const text = num(rounded, 1).replace(/,0$/, "");
  const word = Number.isInteger(rounded) && plural(rounded, ["раз", "раза", "раз"]) === "раз" ? "раз" : "раза";
  return `в ${text} ${word}`;
}

type Rule = [RegExp, (m: RegExpMatchArray) => string];
function translate(text: string, rules: Rule[]): string {
  for (const [re, fn] of rules) {
    const m = text.trim().match(re);
    if (m) return fn(m);
  }
  return text;
}
const ru = (n: string) => n.replace(".", ",");

// The API speaks English; plain Russian for a first-time reader.
const CASE_RULES: Rule[] = [
  [/^(\d+) hours of wind missing in the primary source$/i, (m) => `Пропали ${m[1]} ч ветра`],
  [/^wind spike (\d+) m\/s only in the freshest run/i, (m) => `Ложный ветер ${m[1]} м/с в последнем прогнозе погоды`],
  [/^wind spike (\d+) m\/s in the primary source$/i, (m) => `Ложный ветер ${m[1]} м/с во всех прогнозах погоды`],
  [/^primary source unavailable$/i, () => "Источник погоды не отвечает"],
  [/^both sources broken$/i, () => "Сломаны оба источника погоды"],
];

const AGENT_DECISION_RULES: Rule[] = [
  [/^switch\s*→\s*(.+)$/i, () => "взял запасной источник"],
  [/^older_run$/i, () => "взял прогноз погоды постарше"],
  [/^climatology$/i, () => "перешёл на климатическую норму"],
];

const DECISION_RULES: Rule[] = [
  [/^main model vs fallback/i, () => "Основная модель вместо запасной"],
  [/^recompute at t0\+12/i, () => "Уточнение в 12:00"],
  [/^fallback to a simpler model/i, () => "Переход на простую модель"],
  [/^switch the weather source/i, () => "Смена источника погоды"],
  [/^drift flag/i, () => "Сигнал о дрейфе модели"],
];

const ASSUMPTION_RULES: Rule[] = [
  [/^bid hours \(lead (\d+)-(\d+)\)$/i, () => "только часы заявки на завтра"],
  [/^([\d.]+) MW$/i, (m) => `мощность ${ru(m[1])} МВт`],
  [/^([\d.]+) tg\/kWh$/i, (m) => `цена ${ru(m[1])} ₸/кВт·ч`],
  [/^penalty ([\d.]+) x price for every kWh \(all hours outside \+-(\d+) %\)$/i,
    (m) => `штраф ${ru(m[1])} × цена за каждый кВт·ч в часах вне ±${m[2]} %`],
  [/^new-contract regime$/i, () => "режим новых договоров"],
];

const VARIANT_LABEL: Record<string, string> = {
  A: "Прогноз «как вчера»",
  B: "Кривая мощности без проверок",
  C: "Только модель",
  D: "Агент",
};
const variantKey = (variant: string) => (variant[1] === " " ? variant[0].toUpperCase() : "");

const MODEL_ORDER = ["persistence", "climatology", "power_curve", "gbm"];
const byModel = (a: string, b: string) => {
  const i = (m: string) => (MODEL_ORDER.includes(m) ? MODEL_ORDER.indexOf(m) : MODEL_ORDER.length);
  return i(a) - i(b);
};
const modelName = (m: string) =>
  m === "persistence" ? "Прогноз «как вчера»" : m === "gbm" ? "Агент (бустинг)" : cap(MODEL_LABEL[m] ?? m);

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
      <Icon className={cn("mt-[0.2em] size-4 shrink-0", TONE_COLOR[tone])} aria-hidden />
      <span>{children}</span>
    </span>
  );
}

function Code({ children }: { children: ReactNode }) {
  return <code className="rounded bg-muted px-1.5 py-0.5 text-sm text-foreground">{children}</code>;
}

type Failure = { status: number; message: string };
type Result<T> = { ok: true; data: T } | { ok: false; error: Failure };

function failure(reason: unknown): Failure {
  if (reason instanceof ApiError) return { status: reason.status, message: reason.message };
  return { status: -1, message: reason instanceof Error ? reason.message : "неизвестная ошибка" };
}

function LoadError({ error, onRetry }: { error: Failure; onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert />
      <AlertTitle>
        {error.status === 0 ? "Сервис прогноза не запущен" : `Сервис ответил ошибкой${error.status > 0 ? ` ${error.status}` : ""}`}
      </AlertTitle>
      <AlertDescription>
        Запустите из корня проекта: <Code>{START_API}</Code>
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

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true" aria-label="Загружаем метрики">
      <div className="flex flex-col gap-3">
        <Skeleton className="h-9 w-64" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <div className="grid grid-cols-2 gap-8 lg:grid-cols-4">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col gap-2">
            <Skeleton className="h-4 w-24" />
            <Skeleton className="h-10 w-32" />
          </div>
        ))}
      </div>
      <Skeleton className="h-80 w-full rounded-xl" />
    </div>
  );
}

// ---- hero: agent vs "как вчера" --------------------------------------------------------------

function CompareBar({ label, value, max, accent }: { label: string; value: number; max: number; accent?: boolean }) {
  return (
    <div>
      <div className="flex items-baseline justify-between gap-4">
        <span className={accent ? "text-base font-medium" : "text-base text-muted-foreground"}>{label}</span>
        <span className={cn("text-3xl font-semibold tracking-tight tabular-nums sm:text-4xl",
          accent ? "text-primary" : "text-muted-foreground")}>
          {num(value, 0)}
          <span className="ml-1 text-lg font-normal">%</span>
        </span>
      </div>
      <div className="mt-3 h-4">
        <div
          className={cn("h-full rounded-full transition-[width] duration-300 ease-(--ease-out-strong) motion-reduce:transition-none",
            accent ? "bg-primary" : "bg-chart-4/60")}
          style={{ width: `${Math.max((value / max) * 100, 2)}%` }}
        />
      </div>
    </div>
  );
}

function Hero({ agent, base, period }: { agent: number; base: number; period: string }) {
  const ratio = base / agent;
  const headline =
    ratio >= 1.5 ? `${cap(times(ratio))} точнее, чем прогноз «как вчера»`
      : ratio > 1 ? `На ${share(1 - agent / base)} точнее, чем прогноз «как вчера»`
        : "Не точнее прогноза «как вчера»";
  return (
    <Card className="gap-0 overflow-visible p-6 sm:p-10">
      <h2 className="text-2xl font-semibold tracking-tight sm:text-3xl">{headline}</h2>
      <p className="mt-2 text-muted-foreground">Средняя ошибка, % от мощности станции</p>
      <div className="mt-10 flex flex-col gap-8">
        <CompareBar label="Агент" value={agent} max={Math.max(agent, base)} accent />
        <CompareBar label="Прогноз «как вчера»" value={base} max={Math.max(agent, base)} />
      </div>
      <div className="mt-8">
        <Explain>
          <div className="flex flex-col gap-2">
            <p>
              Каждый день месяца прогноз сделан заново — только с той погодой, что была известна утром. Потом
              его сравнили с фактом.
            </p>
            <p>Ошибка — насколько прогноз в среднем за час расходится с фактом, в % от {RATED_MW} МВт.</p>
            <p>Прогноз «как вчера» — простая база: следующие сутки такие же, как последние 24 часа.</p>
            <p>Коридор — диапазон, в который факт должен попадать в 8 случаях из 10.</p>
            <p className="text-muted-foreground">
              {cap(periodLabel(period))} участвовал в настройке, поэтому цифры могут быть чуть оптимистичны.
              Независимый тест — февраль 2026, его проверяют организаторы.
            </p>
          </div>
        </Explain>
      </div>
    </Card>
  );
}

// ---- stats -----------------------------------------------------------------------------------

function RecomputeStat({ report, replay }: { report: MetricsReport; replay?: ReplayEvidence }) {
  const label = "Уточнение в 12:00";
  const d = replay?.month === report.period
    ? replay.decisions.find((x) => /^recompute/i.test(x.decision))
    : undefined;
  if (d && d.wins !== undefined && d.fired > 0) {
    return (
      <Stat label={label} value={d.wins} unit={`из ${d.fired} ${plural(d.fired, ["дня", "дней", "дней"])}`}
        note="стало точнее" />
    );
  }
  const r = report.extras.recompute_t0_plus_12h;
  const before = r?.mae_rev0;
  const after = r?.mae_rev1;
  if (typeof before === "number" && typeof after === "number" && before > 0) {
    const gain = 1 - after / before;
    return (
      <Stat label={label} value={`${gain > 0 ? MINUS : "+"}${num(Math.abs(gain) * 100, 1)}`} unit="%"
        note="к ошибке за сегодня" />
    );
  }
  return <Stat label={label} value="—" note="нет данных" />;
}

// ---- faults ----------------------------------------------------------------------------------

function Faults({ faults }: { faults: FaultsEvidence }) {
  const H = "horizon_h" in faults && typeof faults.horizon_h === "number" ? faults.horizon_h : 48;
  const cols = "grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] sm:gap-x-8";
  return (
    <Section
      title="Устойчивость к сбоям"
      help={
        <>
          Прогноз на {fullDate(faults.issue)} сделали {faults.cases.length} раз, каждый раз намеренно портя погоду
          на входе. «Без агента» — та же схема, но без проверок данных.
        </>
      }
    >
      <div className={cn(cols, "hidden pb-3 text-sm text-muted-foreground sm:grid")}>
        <span>Что сломали</span>
        <span>Агент</span>
        <span>Без агента</span>
      </div>
      <ul className="divide-y divide-border/60">
        {faults.cases.map((c) => {
          const a = c.agent;
          const f = c.fixed_pipeline;
          const broken = f.hours_from_broken_input ?? 0;
          const aTone: Tone = a.error || a.valid_hours === 0 ? "bad" : a.valid_hours < H ? "warn" : "ok";
          const fTone: Tone = f.error || f.valid_hours < H ? "bad" : broken > 0 ? "warn" : "ok";
          const fText =
            f.error || f.valid_hours === 0 ? "прогноза нет"
              : f.valid_hours < H ? `${H - f.valid_hours} ч пропало`
                : broken > 0 ? `${broken} ч по битой погоде`
                  : `${f.valid_hours} из ${H} ч`;
          return (
            <li key={c.case} className={cn(cols, "py-5")}>
              <span className="col-span-2 font-medium sm:col-span-1" title={c.case}>
                {translate(c.case, CASE_RULES)}
              </span>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-muted-foreground sm:hidden">Агент</span>
                <Status tone={aTone}>{a.error ? "ошибка" : `${a.valid_hours} из ${H} ч`}</Status>
                {a.decision && (
                  <span className="text-sm text-muted-foreground">{translate(a.decision, AGENT_DECISION_RULES)}</span>
                )}
              </div>
              <div className="flex flex-col gap-0.5">
                <span className="text-sm text-muted-foreground sm:hidden">Без агента</span>
                <Status tone={fTone}>{fText}</Status>
              </div>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

// ---- details for experts ---------------------------------------------------------------------

function ExpertHeading({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="mb-4">
      <h3 className="font-medium">{title}</h3>
      {hint && <p className="text-sm text-muted-foreground">{hint}</p>}
    </div>
  );
}

function ModelsTable({ report }: { report: MetricsReport }) {
  const pick = (model: string, h: MetricRow["horizon"]) =>
    report.rows.find((r) => r.model === model && r.horizon === h);
  const models = [...new Set(report.rows.map((r) => r.model))].sort(byModel);
  const issues = typeof report.extras.issues === "number" ? report.extras.issues : null;
  return (
    <div>
      <ExpertHeading
        title={`Все модели, ${periodLabel(report.period)}`}
        hint={`Обучение до ${fullDate(report.train_end)}${issues !== null ? `, ${issues} ${plural(issues, ["выпуск", "выпуска", "выпусков"])}` : ""}. Сегодня — часы 0–23 выпуска, завтра — 24–47.`}
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Модель</TableHead>
            <TableHead className="text-right">Ошибка сегодня</TableHead>
            <TableHead className="text-right">Ошибка завтра</TableHead>
            <TableHead className="text-right">MAE</TableHead>
            <TableHead className="text-right">RMSE</TableHead>
            <TableHead className="text-right">Смещение</TableHead>
            <TableHead className="text-right">Лучше «как вчера»</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {models.map((m) => {
            const all = pick(m, "all");
            const d1 = pick(m, "24h");
            const d2 = pick(m, "48h");
            const main = m === "gbm";
            return (
              <TableRow key={m} className={main ? "font-medium" : undefined}>
                <TableCell>{modelName(m)}</TableCell>
                <TableCell className="text-right tabular-nums">{d1 ? `${num(d1.nmae, 1)} %` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{d2 ? `${num(d2.nmae, 1)} %` : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{all ? mw(all.mae, 2) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{all ? mw(all.rmse, 2) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">{all ? signedMw(all.bias) : "—"}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {m === "persistence" || !all || all.skill_vs_persistence === null ? "—" : share(all.skill_vs_persistence)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

function verdict(ci: [number, number]): { tone: Tone; text: string } {
  if (ci[1] < 0) return { tone: "ok", text: "помогает" };
  if (ci[0] > 0) return { tone: "bad", text: "вредит" };
  return { tone: "unknown", text: "не доказано" };
}

function Ablation({ replay }: { replay: ReplayEvidence }) {
  const items = replay.ablation.map((a) => ({
    key: variantKey(a.variant),
    label: VARIANT_LABEL[variantKey(a.variant)] ?? a.variant,
    value: a.mae,
  }));
  const agentIdx = items.findIndex((i) => i.key === "D");
  return (
    <div className="flex flex-col gap-12">
      <div>
        <ExpertHeading title={`Вклад агента, ${periodLabel(replay.month)}`} hint="Средняя ошибка за час, меньше — лучше" />
        <Bars items={items} highlight={agentIdx >= 0 ? agentIdx : undefined} format={(v) => mw(v, 2)} />
      </div>
      <div>
        <ExpertHeading title="Решения агента" hint="Эффект на ошибку за час и 95 % интервал; минус — ошибка меньше" />
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Решение</TableHead>
              <TableHead className="text-right">Сработало</TableHead>
              <TableHead className="text-right">Эффект</TableHead>
              <TableHead className="text-right">95 % интервал</TableHead>
              <TableHead>Итог</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {replay.decisions.map((d) => {
              const v = d.ci95 ? verdict(d.ci95) : null;
              return (
                <TableRow key={d.decision}>
                  <TableCell title={d.decision}>{translate(d.decision, DECISION_RULES)}</TableCell>
                  <TableCell className="text-right tabular-nums">{d.fired} из {replay.issues}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.fired === 0 || d.mean_delta_mae === null ? "—" : signedMw(d.mean_delta_mae)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {d.ci95 ? `${signedMw(d.ci95[0])} … ${signedMw(d.ci95[1])}` : "—"}
                  </TableCell>
                  <TableCell>
                    {v ? <Status tone={v.tone}>{v.text}</Status> : <Status tone="muted">не срабатывало</Status>}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}

function Money({ report }: { report: MetricsReport }) {
  const cost = report.extras.imbalance_cost_upper_bound_mln_tg;
  const rows = cost
    ? Object.entries(cost)
        .filter((e): e is [string, number] => typeof e[1] === "number")
        .sort((a, b) => byModel(a[0], b[0]))
    : [];
  if (rows.length === 0) return null;
  const base = rows.find(([m]) => m === "persistence")?.[1];
  const assumptions = typeof cost?.assumptions === "string"
    ? cost.assumptions.split(/,\s*/).map((p) => translate(p, ASSUMPTION_RULES)).join("; ")
    : null;
  return (
    <div>
      <ExpertHeading
        title={`Штраф за небаланс, ${periodLabel(report.period)}`}
        hint="Верхняя оценка: штраф с каждого кВт·ч отклонения. Реальная сумма зависит от договора."
      />
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Модель</TableHead>
            <TableHead className="text-right">Штраф</TableHead>
            <TableHead className="text-right">Экономия к «как вчера»</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(([m, v]) => (
            <TableRow key={m} className={m === "gbm" ? "font-medium" : undefined}>
              <TableCell>{modelName(m)}</TableCell>
              <TableCell className="text-right tabular-nums">{num(v, 2)} млн ₸</TableCell>
              <TableCell className="text-right tabular-nums">
                {m === "persistence" || base === undefined ? "—" : signed(base - v, 2, "млн ₸")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {assumptions && <p className="mt-3 text-sm text-muted-foreground">Допущения: {assumptions}.</p>}
    </div>
  );
}

function ForExperts({ report, replay }: { report: MetricsReport; replay?: ReplayEvidence }) {
  return (
    <Section>
      <details className="group">
        <summary className="flex w-fit cursor-pointer list-none items-center gap-2 rounded-md py-1 font-medium text-muted-foreground hover:text-foreground focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-4 transition-transform duration-200 ease-(--ease-out-strong) group-open:rotate-90 motion-reduce:transition-none" aria-hidden />
          Подробнее для экспертов
        </summary>
        <div className="mt-8 flex flex-col gap-12">
          <ModelsTable report={report} />
          {replay && <Ablation replay={replay} />}
          <Money report={report} />
        </div>
      </details>
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
  const setPeriod = (value: string) => {
    const next = new URLSearchParams(params.toString());
    next.set("period", value);
    router.replace(`${pathname}?${next.toString()}`, { scroll: false });
  };

  if (!state) return <PageSkeleton />;

  if (!state.metrics.ok) {
    return (
      <div>
        <PageHeader title="Насколько точно" />
        <LoadError error={state.metrics.error} onRetry={retry} />
      </div>
    );
  }

  const reports = state.metrics.data;
  const wanted = params.get("period");
  const report =
    reports.find((r) => r.period === wanted) ?? reports.find((r) => r.period === "2026-01") ?? reports[0];

  if (!report) {
    return (
      <div>
        <PageHeader title="Насколько точно" />
        <p className="text-muted-foreground">
          Метрик пока нет. Посчитайте их: <Code>uv run python -m app.cli evaluate</Code>
        </p>
      </div>
    );
  }

  const pick = (model: string) => report.rows.find((r) => r.model === model && r.horizon === "all");
  const gbm = pick("gbm");
  const persistence = pick("persistence");
  const coverage = report.extras.interval_p10_p90?.coverage;
  const evidence = state.evidence.ok ? state.evidence.data : null;

  return (
    <div>
      <PageHeader
        title="Насколько точно"
        lead={`Проверка на ${monthOf(report.period, MONTHS_IN)} — там факт уже известен`}
        actions={
          reports.length > 1 && (
            <Tabs value={report.period} onValueChange={(v) => setPeriod(String(v))}>
              <TabsList aria-label="Месяц проверки">
                {reports.map((r) => (
                  <TabsTrigger key={r.period} value={r.period} className="px-3">
                    {cap(periodLabel(r.period))}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          )
        }
      />

      <div className="flex flex-col gap-12">
        <StatRow>
          <Stat label="Ошибка" value={gbm ? num(gbm.mae * RATED_MW, 2) : "—"} unit="МВт" note="в среднем за час" />
          <Stat
            label="Факт в коридоре"
            value={coverage !== undefined ? num(coverage * 100, 0) : "—"}
            unit="% часов"
            note={
              coverage !== undefined && (
                <Status tone={coverage >= COVERAGE_TARGET ? "ok" : "warn"}>
                  {coverage >= COVERAGE_TARGET ? "цель" : "ниже цели"} {share(COVERAGE_TARGET)}
                </Status>
              )
            }
          />
          <RecomputeStat report={report} replay={evidence?.replay} />
        </StatRow>

        {gbm && persistence ? (
          <Hero agent={gbm.nmae} base={persistence.nmae} period={report.period} />
        ) : (
          <p className="text-muted-foreground">Для этого месяца нет сравнения с прогнозом «как вчера».</p>
        )}
      </div>

      <div className="mt-10">
        {!state.evidence.ok ? (
          <Section title="Устойчивость к сбоям">
            <LoadError error={state.evidence.error} onRetry={retry} />
          </Section>
        ) : evidence?.faults ? (
          <Faults faults={evidence.faults} />
        ) : (
          <Section title="Устойчивость к сбоям">
            <p className="text-muted-foreground">
              Проверки пока нет. Запустите: <Code>uv run python -m app.cli faults</Code>
            </p>
          </Section>
        )}
        <ForExperts report={report} replay={evidence?.replay} />
      </div>
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

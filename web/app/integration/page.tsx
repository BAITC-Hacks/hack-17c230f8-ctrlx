"use client";

import Link from "next/link";
import { Fragment, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  Building2,
  Check,
  ChevronRight,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CloudSun,
  Copy,
  ExternalLink,
  FolderOpen,
  LayoutDashboard,
  type LucideIcon,
  Server,
} from "lucide-react";
import { ApiError, RATED_MW, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { PageHeader, Section } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";

const START_API = "uv run uvicorn app.main:app --port 8000";
const TITLE = "Для ИТ-службы";
const LEAD = "Как подключить WindCast к системам компании";

// ---- static content: every fact below is taken from the repo (app/api/routes.py, Dockerfile,
// README, app/agent/orchestrator.py), not invented for the page -------------------------------

interface FlowNode {
  icon: LucideIcon;
  title: string;
  tech: string;
  pilot?: boolean;
}

const PIPELINE: FlowNode[] = [
  { icon: CloudSun, title: "Прогноз погоды", tech: "Open-Meteo" },
  { icon: Bot, title: "Агент WindCast", tech: "Python" },
  { icon: FolderOpen, title: "Файлы прогнозов", tech: "CSV и JSON" },
  { icon: Server, title: "API", tech: "HTTP, порт 8000" },
];

const CONSUMERS: FlowNode[] = [
  { icon: LayoutDashboard, title: "Эта платформа", tech: "Next.js" },
  { icon: Building2, title: "Системы компании", tech: "SCADA, АСКУЭ", pilot: true },
];

interface Endpoint {
  method: "GET" | "POST";
  path: string;
  purpose: string;
}

const ENDPOINTS: Endpoint[] = [
  { method: "GET", path: "/api/health", purpose: "Сервис работает" },
  { method: "GET", path: "/api/issues", purpose: "Список всех прогнозов" },
  { method: "GET", path: "/api/forecast/{date}", purpose: "Прогноз на 48 часов" },
  { method: "GET", path: "/api/runs/{run_id}/log", purpose: "Шаги агента" },
  { method: "GET", path: "/api/metrics", purpose: "Точность по месяцам" },
  { method: "GET", path: "/api/evidence", purpose: "Проверка решений агента" },
  { method: "POST", path: "/api/run", purpose: "Запустить новый прогноз" },
  { method: "POST", path: "/api/ask", purpose: "Задать вопрос агенту" },
];

const DOCKER = `docker build -t windcast .
docker run -p 8000:8000 windcast`;

const PLATFORM = `cd web
pnpm install
export WINDCAST_API_URL=http://<адрес API>:8000
pnpm build
pnpm start`;

const LLM_ENV = `# .env.local — не в образе и не в репозитории
LLM_BASE_URL=http://<адрес NIM>/v1
LLM_MODEL=<открытая модель из каталога NIM>
LLM_API_KEY=<ключ доступа к NIM>

docker run --env-file .env.local -p 8000:8000 windcast`;

interface Step {
  title: string;
  note: string;
  code: string;
}

const STEPS: Step[] = [
  { title: "Агент и API", note: "Docker, порт 8000", code: DOCKER },
  { title: "Платформа", note: "Node.js, порт 3000", code: PLATFORM },
  { title: "Своя LLM", note: "NVIDIA NIM, по желанию", code: LLM_ENV },
];

// cron runs in the server's zone; UTC is the portable choice, hence 02:00 UTC for 07:00 in Astana
const CRON = String.raw`# crontab сервера в UTC: 02:00 UTC — это 07:00 по Астане
0 2 * * * curl -fsS -X POST http://<адрес API>:8000/api/run -H 'content-type: application/json' -d "{\"issue_date\":\"$(date -u -d yesterday +\%F)\",\"refresh\":true}"`;

interface Column {
  names: string[];
  meaning: string;
}

const MONTH_COLUMNS: Column[] = [
  { names: ["target_time_utc", "target_time_local"], meaning: "Час прогноза: UTC и местное время (UTC+5)." },
  {
    names: ["power_farm_plan", "power_t1_plan", "power_t2_plan"],
    meaning: "Последний прогноз на этот час: станция и каждая турбина.",
  },
  { names: ["p10_plan", "p90_plan"], meaning: "Расчётный интервал p10–p90; фактическое покрытие проверяется на исторических данных." },
  {
    names: ["plan_revision", "plan_run_id"],
    meaning: "0 — прогноз в 00:00, 1 — уточнение в 12:00; журнал прогона в runs/<run_id>/.",
  },
  {
    names: ["power_farm_bid", "bid_run_id"],
    meaning: "Черновик заявки из исходного выпуска D+2; автоматической подачи нет. Для 1 февраля пусто.",
  },
  { names: ["plan_mw", "bid_mw"], meaning: `План и заявка в МВт (мощность станции ${RATED_MW} МВт).` },
];

const BID_COLUMNS: Column[] = [
  { names: ["hour_astana"], meaning: "Час поставки по местному времени, «ГГГГ-ММ-ДД ЧЧ:00»." },
  { names: ["plan_mwh"], meaning: "Заявка на час, МВт·ч." },
  { names: ["p10_mwh", "p90_mwh"], meaning: "Границы коридора, МВт·ч: показывают риск, в заявку не входят." },
];

const MONTH_HEADER =
  "target_time_utc,target_time_local,power_farm_plan,power_t1_plan,power_t2_plan,p10_plan,p90_plan,plan_revision,plan_run_id,power_farm_bid,bid_run_id,plan_mw,bid_mw";
const BID_HEADER = "hour_astana,plan_mwh,p10_mwh,p90_mwh";

const PILOT: { title: string; text: string }[] = [
  { title: "Несколько станций", text: "ВЭС Шелек (60 МВт) и ВЭС 1 ГВт с Masdar, у каждой своя проверка точности." },
  { title: "Корпоративный вход", text: "Роли диспетчера, специалиста по заявкам и аналитика." },
  { title: "Уведомления в Telegram", text: "О резком наборе или сбросе мощности и о штиле." },
  { title: "Заявка прямо на рынок", text: "Сейчас это CSV; в пилоте — передача после подтверждения диспетчером." },
  { title: "Точное время прогонов погоды", text: "Open-Meteo Single Runs API вместо принятой задержки 7 часов." },
];

// ---- small pieces --------------------------------------------------------------------------

type Health =
  | { kind: "loading" }
  | { kind: "ok"; mode: "llm" | "demo"; commit: string }
  | { kind: "error"; message: string };

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? "Сервис прогноза не отвечает" : `Ошибка ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : "Неизвестная ошибка";
}

function HealthStatus({ health }: { health: Health }) {
  if (health.kind === "loading") return <Skeleton className="h-5 w-32" aria-label="Проверяем API" />;
  if (health.kind === "error")
    return (
      <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
        <CircleAlert className="size-4" aria-hidden />
        API не отвечает
      </p>
    );
  return (
    <p className="flex items-center gap-1.5 text-sm font-medium">
      <CircleCheck className="size-4 text-[var(--ok)]" aria-hidden />
      API работает
    </p>
  );
}

function Node({ node }: { node: FlowNode }) {
  const Icon = node.icon;
  return (
    <div className="flex min-w-0 items-center gap-3">
      <span
        className={cn(
          "flex size-11 shrink-0 items-center justify-center rounded-full",
          node.pilot
            ? "border-2 border-dashed border-muted-foreground/50 text-muted-foreground"
            : "bg-accent text-accent-foreground",
        )}
      >
        <Icon className="size-5" aria-hidden />
      </span>
      <div className="min-w-0">
        <div className={cn("leading-snug font-medium", node.pilot && "text-muted-foreground")}>{node.title}</div>
        <div className="text-sm text-muted-foreground">{node.tech}</div>
        {node.pilot && (
          <div className="mt-0.5 flex items-center gap-1 text-sm text-muted-foreground">
            <CircleDashed className="size-3.5" aria-hidden />в пилоте
          </div>
        )}
      </div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div
      aria-hidden
      className="flex h-10 w-11 shrink-0 items-center justify-center text-muted-foreground/70 xl:h-auto xl:w-auto xl:px-3"
    >
      <ArrowDown className="size-4 xl:hidden" />
      <ArrowRight className="hidden size-4 xl:block" />
    </div>
  );
}

function Diagram() {
  return (
    <div role="group" aria-label="Путь данных" className="flex flex-col xl:flex-row xl:items-center">
      {PIPELINE.map((node) => (
        <Fragment key={node.title}>
          <div className="min-w-0 xl:flex-1">
            <Node node={node} />
          </div>
          <FlowArrow />
        </Fragment>
      ))}
      <div className="flex min-w-0 flex-col gap-6 sm:flex-row sm:gap-12 xl:flex-[1.25] xl:flex-col xl:gap-6">
        {CONSUMERS.map((node) => (
          <Node key={node.title} node={node} />
        ))}
      </div>
    </div>
  );
}

function PathText({ path }: { path: string }) {
  return (
    <span className="break-all">
      {path.split(/(\{[^}]+\})/).map((part, i) =>
        part.startsWith("{") ? (
          <span key={i} className="text-primary">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </span>
  );
}

function CodeBlock({ code }: { code: string }) {
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");

  useEffect(() => {
    if (copied === "idle") return;
    const t = setTimeout(() => setCopied("idle"), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied("ok");
    } catch {
      setCopied("fail");
    }
  }

  return (
    <div className="relative min-w-0 rounded-lg bg-muted/70">
      <pre className="overflow-x-auto py-4 pr-14 pl-4 font-mono text-[13px] leading-relaxed">
        <code>{code}</code>
      </pre>
      <Button variant="ghost" size="sm" onClick={copy} className="absolute top-2 right-2 bg-muted" aria-live="polite">
        {copied === "ok" ? <Check aria-hidden /> : <Copy aria-hidden />}
        <span className={cn(copied === "idle" && "sr-only")}>
          {copied === "ok" ? "Скопировано" : copied === "fail" ? "Выделите вручную" : "Копировать"}
        </span>
      </Button>
    </div>
  );
}

function Columns({ columns }: { columns: Column[] }) {
  return (
    <dl className="grid gap-x-8 gap-y-4 text-sm sm:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]">
      {columns.map((c) => (
        <Fragment key={c.names.join()}>
          <dt className="flex flex-col gap-0.5">
            {c.names.map((n) => (
              <code key={n} className="font-mono text-xs break-all">
                {n}
              </code>
            ))}
          </dt>
          <dd className="text-muted-foreground">{c.meaning}</dd>
        </Fragment>
      ))}
    </dl>
  );
}

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-4">
      <h3 className="font-semibold">{title}</h3>
      {children}
    </div>
  );
}

function Mono({ children }: { children: ReactNode }) {
  return <code className="font-mono text-[13px] text-foreground">{children}</code>;
}

function ExpertNotes({ health }: { health: Health }) {
  return (
    <details className="group border-t border-border/70 pt-8">
      <summary className="flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-md text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
        <ChevronRight className="size-4 transition-transform duration-150 group-open:rotate-90" aria-hidden />
        Подробнее для экспертов
      </summary>

      <div className="mt-8 flex max-w-4xl flex-col gap-12 text-sm leading-relaxed">
        <Block title="Как устроена связка">
          <ul className="flex list-disc flex-col gap-2 pl-5 text-muted-foreground">
            <li>
              Браузер ходит только в платформу: она проксирует <Mono>/api/*</Mono> и <Mono>/docs</Mono>, поэтому API
              остаётся во внутренней сети и не требует CORS.
            </li>
            <li>
              Если библиотека модели не загружается, готовые прогнозы открываются как обычно, а запуск нового отвечает
              ошибкой 503 с объяснением.
            </li>
            <li>Сейчас история турбин — выгрузка из ТЗ кейса. В пилоте факт выработки придёт из АСКУЭ и SCADA.</li>
            <li>
              Машиночитаемая схема — <Mono>/openapi.json</Mono>: из неё генерируется клиент для любой системы.
            </li>
            {health.kind === "ok" && (
              <li>
                Сейчас: версия <Mono>{health.commit}</Mono>, {health.mode === "llm" ? "LLM настроена; доступ к провайдеру этим запросом не проверяется" : "сводки по шаблону, без LLM"}.
              </li>
            )}
          </ul>
          <CodeBlock code={"curl -s http://<адрес API>:8000/api/health"} />
        </Block>

        <Block title="Ежедневный запуск — план пилота">
          <p className="text-muted-foreground">
            Пример для будущего пилота после подключения свежих погодных прогонов и SCADA. Это не готовая эксплуатационная интеграция. Журнал каждого запуска доступен в{" "}
            <Mono>GET /api/runs/{"{run_id}"}/log</Mono> и на экране{" "}
            <Link href="/agent" className="text-primary underline-offset-4 hover:underline">
              «Агент»
            </Link>
            .
          </p>
          <CodeBlock code={CRON} />
        </Block>

        <Block title="Форматы файлов">
          <p className="text-muted-foreground">
            CSV в UTF-8, разделитель — запятая. Мощность без единиц — доля собственного номинала (0–1):
            для станции умножьте на {RATED_MW} МВт, для отдельной турбины — на {RATED_MW / 2} МВт.
          </p>
          <div className="flex flex-col gap-4 pt-2">
            <div>
              <Mono>outputs/forecasts/february_2026.csv</Mono>
              <p className="mt-1 text-muted-foreground">Итог февраля 2026: строка на каждый час.</p>
            </div>
            <Columns columns={MONTH_COLUMNS} />
            <CodeBlock code={MONTH_HEADER} />
          </div>
          <div className="flex flex-col gap-4 pt-6">
            <div>
              <Mono>runs/&lt;run_id&gt;/bid_ГГГГ-ММ-ДД.csv</Mono>
              <p className="mt-1 text-muted-foreground">
                Черновик заявки на завтра — тот же файл, что скачивается на экране{" "}
                <Link href="/bid" className="text-primary underline-offset-4 hover:underline">
                  «Суточная заявка»
                </Link>
                .
              </p>
            </div>
            <Columns columns={BID_COLUMNS} />
            <CodeBlock code={BID_HEADER} />
          </div>
          <p className="pt-2 text-muted-foreground">
            Полная история каждого прогноза с уточнениями — <Mono>outputs/forecasts/issue_ГГГГ-ММ-ДД.csv</Mono>, поля
            как в ответе <Mono>GET /api/forecast/{"{date}"}</Mono>.
          </p>
        </Block>

        <Block title="Что добавим в пилоте">
          <ul className="flex flex-col gap-3">
            {PILOT.map((p) => (
              <li key={p.title}>
                <span className="font-medium">{p.title}.</span>{" "}
                <span className="text-muted-foreground">{p.text}</span>
              </li>
            ))}
          </ul>
        </Block>
      </div>
    </details>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-10" aria-busy="true" aria-label="Загрузка страницы">
      <div className="space-y-3">
        <Skeleton className="h-9 w-56" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <Skeleton className="h-40 w-full rounded-xl" />
      <div className="space-y-4">
        {Array.from({ length: 5 }, (_, i) => (
          <Skeleton key={i} className="h-5 w-full max-w-xl" />
        ))}
      </div>
    </div>
  );
}

// ---- screen --------------------------------------------------------------------------------

function IntegrationScreen() {
  const [health, setHealth] = useState<Health>({ kind: "loading" });

  useEffect(() => {
    let alive = true;
    api
      .health()
      .then((h) => {
        if (!alive) return;
        setHealth(
          h.ok ? { kind: "ok", mode: h.mode, commit: h.commit } : { kind: "error", message: "Сервис ответил, что не готов" },
        );
      })
      .catch((e: unknown) => {
        if (alive) setHealth({ kind: "error", message: errorText(e) });
      });
    return () => {
      alive = false;
    };
  }, []);

  return (
    <div className="flex flex-col">
      <PageHeader title={TITLE} lead={LEAD} actions={<HealthStatus health={health} />} />

      {health.kind === "error" && (
        <Alert variant="destructive" className="mb-8 max-w-2xl">
          <CircleAlert aria-hidden />
          <AlertTitle>{health.message}</AlertTitle>
          <AlertDescription>
            <p>
              Запустите в папке проекта:{" "}
              <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{START_API}</code>
            </p>
          </AlertDescription>
        </Alert>
      )}

      <Section
        title="Как устроено"
        help={
          <ul className="flex flex-col gap-2">
            <li>Стрелки — путь данных.</li>
            <li>Агент берёт прогноз погоды, считает выработку на 48 часов и сохраняет файлы.</li>
            <li>API отдаёт эти файлы. Платформа и системы компании читают одно и то же.</li>
            <li>Пунктир — подключим в пилоте: заявка уйдёт на рынок, факт выработки вернётся агенту.</li>
          </ul>
        }
      >
        <Card>
          <CardContent className="px-6 py-4 sm:px-10 sm:py-6">
            <Diagram />
          </CardContent>
        </Card>
      </Section>

      <Section
        title="API"
        help={
          <ul className="flex flex-col gap-2">
            <li>GET только читают готовые файлы. POST запускают агента или задают ему вопрос.</li>
            <li>Дата в пути — день прогноза в формате ГГГГ-ММ-ДД.</li>
            <li>Ответы — JSON. Полное описание — в спецификации.</li>
          </ul>
        }
      >
        <ul className="flex flex-col gap-4">
          {ENDPOINTS.map((e) => (
            <li
              key={`${e.method} ${e.path}`}
              className="flex flex-col gap-1 lg:flex-row lg:items-baseline lg:gap-8"
            >
              <code className="flex shrink-0 items-baseline gap-3 font-mono text-sm lg:w-72">
                <span
                  className={cn(
                    "w-10 shrink-0 text-xs font-semibold",
                    e.method === "POST" ? "text-primary" : "text-muted-foreground",
                  )}
                >
                  {e.method}
                </span>
                <PathText path={e.path} />
              </code>
              <span className="pl-[3.25rem] text-muted-foreground lg:pl-0">{e.purpose}</span>
            </li>
          ))}
        </ul>
        <div className="mt-8">
          <a href="/docs" target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline" })}>
            <ExternalLink aria-hidden />
            Открыть спецификацию
          </a>
        </div>
      </Section>

      <Section
        title="Запуск в контуре компании"
        help={
          <ul className="flex flex-col gap-2">
            <li>После установки зависимостей основной сценарий работает без ключей и интернета: сводка собирается по шаблону.</li>
            <li>Ключи и адреса — только в .env.local, не в коде и не в образе.</li>
            <li>LLM лишь переписывает текст сводки. Числа считает код, и каждое сверяется.</li>
          </ul>
        }
      >
        <ol className="flex flex-col gap-10">
          {STEPS.map((s, i) => (
            <li key={s.title} className="grid gap-4 lg:grid-cols-[13rem_minmax(0,1fr)] lg:gap-10">
              <div className="flex items-start gap-3">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-sm font-semibold text-accent-foreground tabular-nums">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="leading-7 font-medium">{s.title}</div>
                  <div className="text-sm text-muted-foreground">{s.note}</div>
                </div>
              </div>
              <CodeBlock code={s.code} />
            </li>
          ))}
        </ol>
      </Section>

      <ExpertNotes health={health} />
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <IntegrationScreen />
    </Suspense>
  );
}

"use client";

import Link from "next/link";
import { Suspense, useEffect, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowRight,
  Bell,
  Bot,
  Braces,
  Building2,
  CalendarClock,
  Check,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CloudSun,
  Container,
  Copy,
  Cpu,
  ExternalLink,
  FolderOpen,
  Info,
  KeyRound,
  LayoutDashboard,
  type LucideIcon,
  Server,
  Timer,
  Upload,
  Wind,
} from "lucide-react";
import { ApiError, RATED_MW, STATION, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

const START_API = "uv run uvicorn app.main:app --port 8000";

// ---- static content: every fact below is taken from the repo (app/api/routes.py, Dockerfile,
// README, app/agent/orchestrator.py), not invented for the page -------------------------------

type Status = "live" | "pilot";

interface FlowNodeData {
  icon: LucideIcon;
  title: string;
  subtitle: string;
  body: ReactNode;
  status: Status;
}

const FLOW: FlowNodeData[] = [
  {
    icon: CloudSun,
    title: "Open-Meteo",
    subtitle: "Previous Runs API",
    body: `Прогоны погоды в том виде, как они вышли: живой запрос по координатам турбин ${STATION} или кэш в репозитории.`,
    status: "live",
  },
  {
    icon: Bot,
    title: "Агент",
    subtitle: "Python, FastAPI",
    body: "Берёт только прогон, допустимый к моменту выпуска по правилу задержки публикации 7 ч, считает прогноз на 48 ч с коридором p10–p90, проверяет себя и пишет сводку.",
    status: "live",
  },
  {
    icon: FolderOpen,
    title: "Выпуски и журналы",
    subtitle: "CSV и JSON",
    body: (
      <>
        <code className="font-mono text-foreground">outputs/</code> — прогнозы и метрики;{" "}
        <code className="font-mono text-foreground">runs/</code> — журнал шагов, сводка и черновик заявки каждого
        прогона.
      </>
    ),
    status: "live",
  },
  {
    icon: Server,
    title: "API",
    subtitle: "HTTP, JSON",
    body: "Методы /api/* и спецификация OpenAPI. Чтение готовых выпусков не зависит от библиотек модели.",
    status: "live",
  },
];

const CONSUMERS: FlowNodeData[] = [
  {
    icon: LayoutDashboard,
    title: "Эта платформа",
    subtitle: "Next.js",
    body: "Экраны диспетчера: выпуски, суточная заявка, журнал агента, точность.",
    status: "live",
  },
  {
    icon: Building2,
    title: "Системы компании",
    subtitle: "АСКУЭ, SCADA, балансирующий рынок",
    body: "Заявка — в систему балансирующего рынка; факт выработки из АСКУЭ и SCADA — обратно агенту, для оценки и дообучения.",
    status: "pilot",
  },
];

interface Endpoint {
  method: "GET" | "POST";
  path: string;
  purpose: string;
  returns: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/api/health",
    purpose: "Сервис жив; подключена ли LLM или сводки собираются по шаблону.",
    returns: "ok, mode, commit",
  },
  {
    method: "GET",
    path: "/api/issues",
    purpose: "Список выпусков в архиве, от старых к новым.",
    returns: "дата, run_id, модель, число ревизий, признак запасной модели",
  },
  {
    method: "GET",
    path: "/api/forecast/{date}",
    purpose:
      "Один выпуск: почасовые строки на 48 ч по всем ревизиям, коридор p10–p90, сводка диспетчеру и замечания агента. Дата — сутки D, по итогам которых сделан выпуск, в формате ГГГГ-ММ-ДД.",
    returns: "ForecastIssue; 404, если выпуска нет",
  },
  {
    method: "GET",
    path: "/api/runs/{run_id}/log",
    purpose: "Журнал прогона: каждый шаг агента с решением, причиной и длительностью.",
    returns: "список AgentStep; 404, если прогона нет",
  },
  {
    method: "GET",
    path: "/api/metrics",
    purpose: "Точность на отложенных месяцах: MAE, nMAE, смещение, выигрыш у персистентности и кривой мощности.",
    returns: "список MetricsReport, новые периоды сверху",
  },
  {
    method: "GET",
    path: "/api/evidence",
    purpose: "Проверка агентности: повтор месяца с отключением решений агента и прогон на сломанных входах.",
    returns: "replay, faults; пустой объект, пока не посчитано",
  },
  {
    method: "POST",
    path: "/api/run",
    purpose:
      "Запустить агента на дату выпуска. Тело: issue_date, refresh — свежая погода из Open-Meteo, llm — сводка через LLM.",
    returns: "run_id и выпуск; 422 — дата внутри периода обучения; 503 — модель не загружается на этой машине",
  },
  {
    method: "POST",
    path: "/api/ask",
    purpose: "Вопрос агенту о выпуске. Тело: run_id и question. Ответ строится только по журналу и прогнозу этого прогона.",
    returns: "answer, mode, grounded, sources",
  },
];

interface Column {
  names: string[];
  meaning: ReactNode;
}

const MONTH_COLUMNS: Column[] = [
  { names: ["target_time_utc", "target_time_local"], meaning: "Час прогноза: UTC и местное время (UTC+5), ISO 8601." },
  {
    names: ["power_farm_plan", "power_t1_plan", "power_t2_plan"],
    meaning:
      "Последний прогноз на этот час для станции и каждой турбины: опережение 0–23 ч из выпуска начала суток, после пересчёта в 12:00 — ревизия 1.",
  },
  { names: ["p10_plan", "p90_plan"], meaning: "Коридор неопределённости p10–p90." },
  {
    names: ["plan_revision", "plan_run_id"],
    meaning: (
      <>
        Ревизия (0 — выпуск в 00:00, 1 — пересчёт в 12:00) и прогон агента; его журнал —{" "}
        <code className="font-mono text-foreground">runs/&lt;run_id&gt;/</code>.
      </>
    ),
  },
  {
    names: ["power_farm_bid", "bid_run_id"],
    meaning:
      "Суточная заявка на этот час: опережение 24–47 ч из выпуска предыдущей ночи, готова до 08:00. Для 1 февраля пусто — её дал бы выпуск до начала тестового периода.",
  },
  { names: ["plan_mw", "bid_mw"], meaning: `План и заявка в МВт (номинал ${RATED_MW} МВт).` },
];

const BID_COLUMNS: Column[] = [
  { names: ["hour_astana"], meaning: "Час поставки по местному времени (UTC+5), «ГГГГ-ММ-ДД ЧЧ:00»." },
  { names: ["plan_mwh"], meaning: "Заявка на час — медиана прогноза, МВт·ч." },
  { names: ["p10_mwh", "p90_mwh"], meaning: "Нижняя и верхняя граница коридора, МВт·ч: показывают риск, в заявку не входят." },
];

const MONTH_HEADER =
  "target_time_utc,target_time_local,power_farm_plan,power_t1_plan,power_t2_plan,p10_plan,p90_plan,plan_revision,plan_run_id,power_farm_bid,bid_run_id,plan_mw,bid_mw";
const BID_HEADER = "hour_astana,plan_mwh,p10_mwh,p90_mwh";

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

// cron runs in the server's zone; UTC is the portable choice, hence 02:00 UTC for 07:00 in Astana
const CRON = String.raw`# crontab сервера в UTC: 02:00 UTC — это 07:00 по Астане
0 2 * * * curl -fsS -X POST http://<адрес API>:8000/api/run -H 'content-type: application/json' -d "{\"issue_date\":\"$(date -u -d yesterday +\%F)\",\"refresh\":true}"`;

interface PilotItem {
  icon: LucideIcon;
  title: string;
  text: string;
}

const PILOT: PilotItem[] = [
  {
    icon: Wind,
    title: "Несколько станций",
    text: "ВЭС Шелек, 60 МВт, и ВЭС 1 ГВт с Masdar. Для каждой нужны история выработки, координаты турбин, номинал и своя проверка точности.",
  },
  {
    icon: KeyRound,
    title: "Вход через корпоративную учётную запись",
    text: "Роли: диспетчер, специалист по заявкам, аналитик — каждый видит свои экраны и действия.",
  },
  {
    icon: Bell,
    title: "Уведомления в Telegram",
    text: "О резком наборе или сбросе мощности и о штиле на горизонте прогноза, со ссылкой на выпуск.",
  },
  {
    icon: Upload,
    title: "Выгрузка заявки в систему балансирующего рынка",
    text: "Сейчас заявка — CSV с экрана «Суточная заявка»; в пилоте — передача напрямую после подтверждения диспетчером.",
  },
  {
    icon: Timer,
    title: "Точные времена прогонов погоды",
    text: "Open-Meteo Single Runs API даст время инициализации каждого прогона вместо принятой задержки публикации 7 часов.",
  },
];

const SECTIONS = [
  { id: "arch", label: "Как устроено" },
  { id: "api", label: "API" },
  { id: "formats", label: "Форматы данных" },
  { id: "deploy", label: "Развёртывание" },
  { id: "pilot", label: "Пилот" },
];

// ---- small pieces --------------------------------------------------------------------------

type Health =
  | { kind: "loading" }
  | { kind: "ok"; mode: "llm" | "demo"; commit: string }
  | { kind: "error"; message: string };

function errorText(e: unknown): string {
  if (e instanceof ApiError) return e.status === 0 ? "Сервис прогноза не отвечает." : `Ошибка ${e.status}: ${e.message}`;
  return e instanceof Error ? e.message : "Неизвестная ошибка.";
}

function HealthStatus({ health }: { health: Health }) {
  if (health.kind === "loading") return <Skeleton className="h-5 w-48" aria-label="Проверяем API" />;
  if (health.kind === "error")
    return (
      <p className="flex items-center gap-1.5 text-sm font-medium text-destructive">
        <CircleAlert className="size-4" aria-hidden />
        API недоступен
      </p>
    );
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
      <span className="flex items-center gap-1.5 font-medium">
        <CircleCheck className="size-4" style={{ color: "var(--ok)" }} aria-hidden />
        API доступен
      </span>
      <span className="text-muted-foreground">
        версия {health.commit}, {health.mode === "llm" ? "LLM подключена" : "без LLM"}
      </span>
    </p>
  );
}

function StatusMark({ status, label }: { status: Status; label?: string }) {
  if (status === "live")
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium" style={{ color: "var(--ok)" }}>
        <CircleCheck className="size-3.5" aria-hidden />
        {label ?? "работает"}
      </span>
    );
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-muted-foreground">
      <CircleDashed className="size-3.5" aria-hidden />
      {label ?? "в пилоте"}
    </span>
  );
}

function FlowNode({ node, className }: { node: FlowNodeData; className?: string }) {
  const Icon = node.icon;
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-2 rounded-lg border p-3",
        node.status === "live" ? "bg-background" : "border-dashed border-muted-foreground/40 bg-card",
        className,
      )}
    >
      <div className="flex items-start gap-2">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
          <Icon className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <div className="text-sm leading-tight font-medium">{node.title}</div>
          <div className="text-xs text-muted-foreground">{node.subtitle}</div>
        </div>
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground">{node.body}</p>
      <div className="mt-auto">
        <StatusMark status={node.status} />
      </div>
    </div>
  );
}

function FlowArrow() {
  return (
    <div aria-hidden className="flex shrink-0 items-center justify-center text-muted-foreground">
      <ArrowDown className="size-4 xl:hidden" />
      <ArrowRight className="hidden size-4 xl:block" />
    </div>
  );
}

function PathText({ path }: { path: string }) {
  return (
    <code className="font-mono text-[13px] font-medium break-all">
      {path.split(/(\{[^}]+\})/).map((part, i) =>
        part.startsWith("{") ? (
          <span key={i} className="text-primary">
            {part}
          </span>
        ) : (
          part
        ),
      )}
    </code>
  );
}

function MethodTag({ method }: { method: Endpoint["method"] }) {
  return (
    <span
      className={cn(
        "inline-flex w-12 justify-center rounded-md px-1.5 py-0.5 font-mono text-xs font-medium",
        method === "GET" ? "bg-accent text-accent-foreground" : "bg-primary text-primary-foreground",
      )}
    >
      {method}
    </span>
  );
}

function CodeBlock({ label, code }: { label: string; code: string }) {
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
    <div className="min-w-0 overflow-hidden rounded-lg border">
      <div className="flex items-center justify-between gap-2 border-b bg-muted/60 py-1 pr-1 pl-3">
        <span className="truncate text-xs text-muted-foreground">{label}</span>
        <Button variant="ghost" size="xs" onClick={copy} aria-live="polite">
          {copied === "ok" ? <Check aria-hidden /> : <Copy aria-hidden />}
          {copied === "ok" ? "Скопировано" : copied === "fail" ? "Выделите вручную" : "Копировать"}
        </Button>
      </div>
      <pre className="overflow-x-auto bg-background/60 px-3 py-2.5 font-mono text-xs leading-relaxed">
        <code>{code}</code>
      </pre>
    </div>
  );
}

function ColumnsTable({ columns }: { columns: Column[] }) {
  return (
    <Table>
      <TableHeader>
        <TableRow className="hover:bg-transparent">
          <TableHead className="w-[42%] pl-0">Колонка</TableHead>
          <TableHead className="pr-0">Что означает</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {columns.map((c) => (
          <TableRow key={c.names.join()} className="hover:bg-transparent">
            <TableCell className="pl-0 align-top">
              <div className="flex flex-col gap-0.5">
                {c.names.map((n) => (
                  <code key={n} className="font-mono text-xs break-all whitespace-normal">
                    {n}
                  </code>
                ))}
              </div>
            </TableCell>
            <TableCell className="pr-0 align-top whitespace-normal text-muted-foreground">{c.meaning}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function Section({
  id,
  title,
  description,
  action,
  children,
}: {
  id: string;
  title: string;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="flex scroll-mt-6 flex-col gap-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0 space-y-1">
          <h2 id={`${id}-title`} className="text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {description && <p className="max-w-3xl text-sm text-muted-foreground">{description}</p>}
        </div>
        {action}
      </div>
      {children}
    </section>
  );
}

function DeployCard({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon className="size-4 shrink-0 text-primary" aria-hidden />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">{children}</CardContent>
    </Card>
  );
}

function Note({ children }: { children: ReactNode }) {
  return (
    <p className="flex gap-2 text-sm text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function PageSkeleton() {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-label="Загрузка страницы">
      <div className="space-y-2">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <Skeleton className="h-64 w-full rounded-xl" />
      <Skeleton className="h-80 w-full rounded-xl" />
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
          h.ok ? { kind: "ok", mode: h.mode, commit: h.commit } : { kind: "error", message: "Сервис ответил, что не готов." },
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
    <div className="flex flex-col gap-10">
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0 space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Интеграция</h1>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Для ИТ-службы: из чего состоит WindCast, какие данные он отдаёт и как развернуть его в контуре компании.
            </p>
          </div>
          <HealthStatus health={health} />
        </div>
        <nav aria-label="Разделы страницы" className="flex flex-wrap gap-2">
          {SECTIONS.map((s) => (
            <a
              key={s.id}
              href={`#${s.id}`}
              className="rounded-md border bg-card px-2.5 py-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              {s.label}
            </a>
          ))}
        </nav>
        {health.kind === "error" && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden />
            <AlertTitle>API не отвечает</AlertTitle>
            <AlertDescription>
              <p>
                {health.message} Описание ниже от API не зависит, но спецификация OpenAPI и примеры запросов заработают
                только после запуска.
              </p>
              <p>
                Выполните в папке проекта:{" "}
                <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-foreground">{START_API}</code>
              </p>
            </AlertDescription>
          </Alert>
        )}
      </div>

      <Section
        id="arch"
        title="Как устроено"
        description="Прогноз считает Python-сервис; всё, что он выпускает, лежит в файлах и отдаётся по HTTP. Эта платформа и системы компании — равноправные клиенты одного API."
        action={
          <div className="flex shrink-0 flex-wrap gap-x-4 gap-y-1">
            <StatusMark status="live" label="работает сейчас" />
            <StatusMark status="pilot" label="в пилоте" />
          </div>
        }
      >
        <Card>
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5 xl:flex-row xl:items-stretch" aria-label="Поток данных" role="group">
              {FLOW.map((node) => (
                <div key={node.title} className="contents">
                  <FlowNode node={node} className="xl:flex-1" />
                  <FlowArrow />
                </div>
              ))}
              <div className="flex min-w-0 flex-col gap-1.5 xl:flex-[1.15]">
                {CONSUMERS.map((node) => (
                  <FlowNode key={node.title} node={node} className="xl:flex-1" />
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-2 border-t pt-4">
              <Note>
                Браузер обращается только к платформе: она проксирует <code className="font-mono">/api/*</code> и{" "}
                <code className="font-mono">/docs</code> на сервис агента, поэтому API может оставаться во внутренней сети
                и не требует CORS.
              </Note>
              <Note>
                Если на машине не загружается библиотека модели, API и платформа продолжают показывать готовые выпуски, а
                запуск нового прогона отвечает ошибкой 503 с объяснением.
              </Note>
              <Note>
                Сейчас история турбин — выгрузка из ТЗ кейса. В пилоте факт выработки будет приходить из АСКУЭ и SCADA.
              </Note>
            </div>
          </CardContent>
        </Card>
      </Section>

      <Section
        id="api"
        title="API"
        description="HTTP и JSON. Методы GET только читают файлы выпусков и журналов; POST запускают агента или задают ему вопрос."
        action={
          <a
            href="/docs"
            target="_blank"
            rel="noreferrer"
            className={cn(buttonVariants({ variant: "outline" }), "self-start sm:self-auto")}
          >
            <Braces aria-hidden />
            Спецификация OpenAPI
            <ExternalLink aria-hidden />
          </a>
        }
      >
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-16 pl-4">Метод</TableHead>
                <TableHead>Путь и назначение</TableHead>
                <TableHead className="hidden w-[32%] pr-4 md:table-cell">Ответ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ENDPOINTS.map((e) => (
                <TableRow key={`${e.method} ${e.path}`} className="hover:bg-transparent">
                  <TableCell className="py-3 pl-4 align-top">
                    <MethodTag method={e.method} />
                  </TableCell>
                  <TableCell className="py-3 align-top whitespace-normal">
                    <PathText path={e.path} />
                    <p className="mt-1 text-muted-foreground">{e.purpose}</p>
                    <p className="mt-1 text-xs text-muted-foreground md:hidden">Ответ: {e.returns}</p>
                  </TableCell>
                  <TableCell className="hidden py-3 pr-4 align-top whitespace-normal text-muted-foreground md:table-cell">
                    {e.returns}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
        <div className="grid gap-3 lg:grid-cols-2">
          <CodeBlock label="Проверка из терминала" code={"curl -s http://<адрес API>:8000/api/health"} />
          <Note>
            Машиночитаемая схема — <code className="font-mono">/openapi.json</code>, из неё генерируется клиент для любой
            системы. Ответы агента на вопросы работают, когда на сервере включён метод{" "}
            <code className="font-mono">POST /api/ask</code>; без него экран «Спросить агента» так и скажет.
          </Note>
        </div>
      </Section>

      <Section
        id="formats"
        title="Форматы данных"
        description={`Обычный CSV в UTF-8, разделитель — запятая. Мощность в колонках без единиц — доля номинала от 0 до 1, как в данных кейса; чтобы получить МВт, умножьте на ${RATED_MW}.`}
      >
        <div className="grid gap-4 xl:grid-cols-[3fr_2fr]">
          <Card className="min-w-0">
            <CardHeader>
              <CardTitle className="font-mono text-sm break-all">outputs/forecasts/february_2026.csv</CardTitle>
              <CardDescription>Итог тестового периода: по строке на каждый час 1–28 февраля 2026.</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <ColumnsTable columns={MONTH_COLUMNS} />
              <CodeBlock label="Заголовок файла" code={MONTH_HEADER} />
            </CardContent>
          </Card>
          <div className="flex min-w-0 flex-col gap-4">
            <Card className="min-w-0">
              <CardHeader>
                <CardTitle className="font-mono text-sm break-all">runs/&lt;run_id&gt;/bid_ГГГГ-ММ-ДД.csv</CardTitle>
                <CardDescription>
                  Черновик суточной заявки: по строке на каждый час суток D+2, где D — сутки, по итогам которых сделан выпуск. Тот же файл скачивается на
                  экране{" "}
                  <Link href="/bid" className="text-primary underline-offset-4 hover:underline">
                    «Суточная заявка»
                  </Link>
                  .
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <ColumnsTable columns={BID_COLUMNS} />
                <CodeBlock label="Заголовок файла" code={BID_HEADER} />
              </CardContent>
            </Card>
            <Note>
              Полная история каждого выпуска со всеми ревизиями —{" "}
              <code className="font-mono">outputs/forecasts/issue_ГГГГ-ММ-ДД.csv</code>. В нём те же поля, что в строках
              ответа <code className="font-mono">GET /api/forecast/{"{date}"}</code>.
            </Note>
          </div>
        </div>
      </Section>

      <Section
        id="deploy"
        title="Как развернуть в контуре компании"
        description="Два сервиса — агент с API и платформа, к ним LLM по желанию и ежедневный запуск. Ключи и адреса — только в переменных окружения, не в коде и не в образе."
      >
        <div className="grid gap-4 lg:grid-cols-2">
          <DeployCard
            icon={Container}
            title="Агент и API в Docker"
            description="Образ собирается из корня репозитория: Python 3.12, агент, обученная модель, архив погоды и готовые выпуски."
          >
            <CodeBlock label="Терминал, корень репозитория" code={DOCKER} />
            <Note>
              Работает сразу без ключей и без сети: прогноз считает код, сводка собирается по шаблону. Для живой погоды
              откройте исходящий доступ к <code className="font-mono">previous-runs-api.open-meteo.com</code>.
            </Note>
          </DeployCard>
          <DeployCard
            icon={LayoutDashboard}
            title="Платформа Next.js"
            description={
              <>
                Папка <code className="font-mono">web</code>. Адрес API задаёт переменная{" "}
                <code className="font-mono">WINDCAST_API_URL</code>, по умолчанию{" "}
                <code className="font-mono">http://localhost:8000</code>.
              </>
            }
          >
            <CodeBlock label="Терминал" code={PLATFORM} />
            <Note>
              Переменная нужна и при сборке, и при запуске, поэтому она задана через export. Платформа слушает порт 3000.
            </Note>
          </DeployCard>
          <DeployCard
            icon={Cpu}
            title="LLM внутри контура"
            description="Открытая модель в NVIDIA NIM на серверах компании: факты выпусков не уходят наружу. NIM отдаёт OpenAI-совместимый интерфейс, а агент использует такой клиент, поэтому достаточно указать адрес."
          >
            <CodeBlock label="Переменные окружения" code={LLM_ENV} />
            <Note>
              LLM не обязательна: числа считает код, модель только переписывает текст сводки, и каждое число в нём
              сверяется с фактами выпуска. Без ключа остаётся шаблон.
            </Note>
          </DeployCard>
          <DeployCard
            icon={CalendarClock}
            title="Расписание"
            description="Каждый день в 07:00 по Астане (UTC+5) — за час до срока подачи суточной заявки в 08:00. Планировщик вызывает запуск прогона за прошедшие сутки со свежей погодой."
          >
            <CodeBlock label="crontab" code={CRON} />
            <Note>
              Каждый запуск пишет журнал: переключения на запасную модель и ошибки видны в{" "}
              <code className="font-mono">GET /api/runs/{"{run_id}"}/log</code> и на экране{" "}
              <Link href="/agent" className="text-primary underline-offset-4 hover:underline">
                «Агент»
              </Link>
              .
            </Note>
          </DeployCard>
        </div>
      </Section>

      <Section
        id="pilot"
        title="Что дальше для пилота"
        description="То, чего пока нет в WindCast и что понадобится для работы в компании."
      >
        <ul className="divide-y overflow-hidden rounded-xl bg-card ring-1 ring-foreground/10">
          {PILOT.map(({ icon: Icon, title, text }) => (
            <li key={title} className="flex gap-3 p-4">
              <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-accent text-accent-foreground">
                <Icon className="size-4" aria-hidden />
              </span>
              <div className="min-w-0 space-y-0.5">
                <div className="text-sm font-medium">{title}</div>
                <p className="text-sm text-muted-foreground">{text}</p>
              </div>
            </li>
          ))}
        </ul>
      </Section>
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

"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  Bot,
  CircleAlert,
  CircleCheck,
  FileText,
  LoaderCircle,
  MessageSquare,
  PlugZap,
  RotateCw,
  ScrollText,
  ServerOff,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { ApiError, api, dayLabel, MODEL_LABEL, type AskAnswer, type IssueListItem } from "@/lib/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

const START_API = "uv run uvicorn app.main:app --port 8000";

const SUGGESTED = [
  "Почему пересчитали прогноз?",
  "Что с погодой в этом выпуске?",
  "Какие риски на завтра?",
  "Сколько энергии ожидается в сутки заявки?",
];

type EntryState =
  | { kind: "pending" }
  | { kind: "done"; answer: AskAnswer }
  | { kind: "unavailable" }
  | { kind: "error"; message: string };

interface Entry {
  id: number;
  question: string;
  state: EntryState;
}

/** FastAPI answers 405 (or 404 "Not Found") while the POST /api/ask route is not wired yet. */
function isMissingEndpoint(e: unknown): boolean {
  return e instanceof ApiError && (e.status === 405 || (e.status === 404 && e.message === "Not Found"));
}

function describeError(e: unknown): string {
  if (!(e instanceof ApiError)) return "Не удалось получить ответ.";
  if (e.status === 0 || e.status >= 500) {
    return `Сервис прогноза не отвечает${e.status ? ` (код ${e.status})` : ""}. Запустите API: ${START_API}`;
  }
  return `Сервер не принял вопрос (код ${e.status}): ${e.message}`;
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// ---- answer text: plain paragraphs and "- " bullet lists, as the agent's summaries are written --------

type Block = { kind: "p"; text: string } | { kind: "ul"; items: string[] };

function toBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  let list: string[] | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim().replace(/\*\*/g, "");
    if (!line) {
      list = null;
      continue;
    }
    const bullet = /^[-•*]\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = [];
        blocks.push({ kind: "ul", items: list });
      }
      list.push(bullet[1]);
    } else {
      list = null;
      blocks.push({ kind: "p", text: line });
    }
  }
  return blocks;
}

function AnswerText({ text }: { text: string }) {
  return (
    <div className="space-y-2 text-base leading-relaxed">
      {toBlocks(text).map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{b.text}</p>
        ) : (
          <ul key={i} className="list-disc space-y-1 pl-5 marker:text-muted-foreground">
            {b.items.map((item, j) => (
              <li key={j}>{item}</li>
            ))}
          </ul>
        ),
      )}
    </div>
  );
}

// ---- pieces ------------------------------------------------------------------------------------

function StatusBadge({ ok, children }: { ok: boolean; children: React.ReactNode }) {
  const color = ok ? "var(--ok)" : "var(--warn)";
  return (
    <Badge
      variant="outline"
      className="h-auto whitespace-normal py-0.5 text-left"
      style={{
        color,
        borderColor: `color-mix(in oklch, ${color} 35%, transparent)`,
        background: `color-mix(in oklch, ${color} 8%, transparent)`,
      }}
    >
      {ok ? <ShieldCheck aria-hidden /> : <TriangleAlert aria-hidden />}
      {children}
    </Badge>
  );
}

function AgentAvatar() {
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-accent text-accent-foreground">
      <Bot className="size-4" aria-hidden />
    </span>
  );
}

function AnswerCard({ answer }: { answer: AskAnswer }) {
  return (
    <Card className="gap-3">
      <CardHeader className="flex flex-wrap items-center gap-2">
        <AgentAvatar />
        <span className="font-medium">Агент</span>
        {answer.mode === "llm" ? (
          <Badge variant="secondary">
            <Bot aria-hidden />
            LLM
          </Badge>
        ) : (
          <Badge variant="secondary">
            <FileText aria-hidden />
            шаблон без LLM
          </Badge>
        )}
        <StatusBadge ok={answer.grounded}>
          {answer.grounded ? "числа сверены с журналом" : "не все числа подтверждены"}
        </StatusBadge>
      </CardHeader>
      <CardContent className="space-y-3">
        <AnswerText text={answer.answer} />
        {answer.fallback_reason && (
          <p className="text-xs text-muted-foreground">LLM не использовалась: {answer.fallback_reason}</p>
        )}
        {answer.sources.length > 0 && (
          <div className="border-t pt-3 text-xs text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-medium text-foreground/80">
              <ScrollText className="size-3.5" aria-hidden />
              Источники
            </div>
            <ul className="list-disc space-y-0.5 pl-5 break-words">
              {answer.sources.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PendingCard() {
  return (
    <Card className="gap-3" aria-busy="true">
      <CardHeader className="flex items-center gap-2">
        <AgentAvatar />
        <span className="font-medium">Агент</span>
        <span className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <LoaderCircle className="size-3.5 motion-safe:animate-spin" aria-hidden />
          читает журнал и прогноз выпуска
        </span>
      </CardHeader>
      <CardContent className="space-y-2">
        <Skeleton className="h-4 w-11/12" />
        <Skeleton className="h-4 w-9/12" />
        <Skeleton className="h-4 w-7/12" />
      </CardContent>
    </Card>
  );
}

function NoAnswer({
  icon,
  text,
  tone,
  onRetry,
  disabled,
}: {
  icon: React.ReactNode;
  text: string;
  tone: "muted" | "error";
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <div
      className={
        "flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border border-dashed px-3 py-2.5 text-sm " +
        (tone === "error" ? "text-destructive" : "text-muted-foreground")
      }
    >
      <span className="flex min-w-0 flex-1 items-start gap-2">
        <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
        <span className="min-w-0 break-words">{text}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onRetry} disabled={disabled}>
        <RotateCw aria-hidden />
        Спросить ещё раз
      </Button>
    </div>
  );
}

function IssueContext({ issue }: { issue: IssueListItem }) {
  const recomputed = issue.revisions > 1;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>Выпуск за {dayLabel(issue.issue_date)}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Модель</dt>
          <dd>{MODEL_LABEL[issue.model_name] ?? issue.model_name}</dd>
          <dt className="text-muted-foreground">Версий прогноза</dt>
          <dd>
            {issue.revisions}
            {recomputed ? " — был пересчёт" : " — без пересчёта"}
          </dd>
          <dt className="text-muted-foreground">Резервная модель</dt>
          <dd className="flex items-center gap-1.5">
            {issue.fallback_used ? (
              <>
                <TriangleAlert className="size-4 shrink-0" style={{ color: "var(--warn)" }} aria-hidden />
                использована
              </>
            ) : (
              <>
                <CircleCheck className="size-4 shrink-0" style={{ color: "var(--ok)" }} aria-hidden />
                не понадобилась
              </>
            )}
          </dd>
          <dt className="text-muted-foreground">Запуск</dt>
          <dd className="font-mono text-xs leading-5 break-all">{issue.run_id}</dd>
        </dl>
        <div className="mt-4 flex flex-wrap gap-2">
          <Link href={`/agent?date=${issue.issue_date}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <ScrollText aria-hidden />
            Журнал агента
          </Link>
          <Link href={`/issues?date=${issue.issue_date}`} className={buttonVariants({ variant: "outline", size: "sm" })}>
            <FileText aria-hidden />
            Прогноз выпуска
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

function PageSkeleton() {
  return (
    <div className="space-y-6" aria-busy="true">
      <div className="space-y-2">
        <Skeleton className="h-7 w-56" />
        <Skeleton className="h-4 w-full max-w-lg" />
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <Skeleton className="h-72 w-full rounded-xl" />
        <Skeleton className="h-48 w-full rounded-xl" />
      </div>
    </div>
  );
}

// ---- screen ------------------------------------------------------------------------------------

function AskScreen() {
  const router = useRouter();
  const params = useSearchParams();
  const dateParam = params.get("date");

  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [loadError, setLoadError] = useState<{ detail: string | null } | null>(null);
  const [reload, setReload] = useState(0);
  const [history, setHistory] = useState<Record<string, Entry[]>>({});
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const seq = useRef(0);
  const composerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    api
      .issues()
      .then((list) => {
        if (!alive) return;
        setIssues([...list].sort((a, b) => a.issue_date.localeCompare(b.issue_date)));
        setLoadError(null);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        setLoadError({
          detail: e instanceof ApiError && e.status > 0 ? `Ответ сервера: ${e.status} ${e.message}` : null,
        });
        setIssues([]);
      });
    return () => {
      alive = false;
    };
  }, [reload]);

  const current = useMemo(() => {
    if (!issues || issues.length === 0) return null;
    return issues.find((i) => i.issue_date === dateParam) ?? issues[issues.length - 1];
  }, [issues, dateParam]);
  const entries = current ? (history[current.run_id] ?? []) : [];
  const lastEntryKey = entries.length ? `${entries[entries.length - 1].id}:${entries[entries.length - 1].state.kind}` : "";

  // Keep the newest answer and the input in view when the history grows.
  useEffect(() => {
    if (!lastEntryKey) return;
    composerRef.current?.scrollIntoView({
      block: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, [lastEntryKey]);

  function patch(runId: string, id: number, state: EntryState) {
    setHistory((h) => ({
      ...h,
      [runId]: (h[runId] ?? []).map((e) => (e.id === id ? { ...e, state } : e)),
    }));
  }

  async function send(runId: string, id: number, question: string) {
    setPending(true);
    patch(runId, id, { kind: "pending" });
    try {
      const answer = await api.ask(runId, question);
      setUnavailable(false);
      patch(runId, id, { kind: "done", answer });
    } catch (e) {
      if (isMissingEndpoint(e)) {
        setUnavailable(true);
        patch(runId, id, { kind: "unavailable" });
      } else {
        patch(runId, id, { kind: "error", message: describeError(e) });
      }
    } finally {
      setPending(false);
    }
  }

  function ask(text: string) {
    const question = text.trim();
    if (!question || !current || pending) return;
    const runId = current.run_id;
    const id = ++seq.current;
    setHistory((h) => ({
      ...h,
      [runId]: [...(h[runId] ?? []), { id, question, state: { kind: "pending" } }],
    }));
    setDraft("");
    void send(runId, id, question);
  }

  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    ask(draft);
  }

  function pickIssue(date: string) {
    router.replace(`/ask?date=${date}`, { scroll: false });
  }

  const header = (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0 space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Спросить агента</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Агент отвечает только по журналу и прогнозу выбранного выпуска и не придумывает числа.
        </p>
      </div>
      {current && issues && (
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">Выпуск</span>
          <Select
            value={current.issue_date}
            onValueChange={(v) => {
              if (typeof v === "string") pickIssue(v);
            }}
            items={Object.fromEntries(issues.map((i) => [i.issue_date, `за ${dayLabel(i.issue_date)}`]))}
          >
            <SelectTrigger className="w-44" aria-label="Выпуск">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[...issues].reverse().map((i) => (
                <SelectItem key={i.issue_date} value={i.issue_date}>
                  за {dayLabel(i.issue_date)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );

  if (issues === null) return <PageSkeleton />;

  if (!current) {
    return (
      <div className="space-y-6">
        {header}
        {loadError ? (
          <Alert variant="destructive">
            <ServerOff aria-hidden />
            <AlertTitle>Не удалось загрузить выпуски</AlertTitle>
            <AlertDescription>
              <p>
                Проверьте, что сервис прогноза запущен: <code className="font-mono">{START_API}</code>
              </p>
              {loadError.detail && <p>{loadError.detail}</p>}
              <Button
                variant="outline"
                size="sm"
                className="mt-2"
                onClick={() => {
                  setIssues(null);
                  setReload((n) => n + 1);
                }}
              >
                <RotateCw aria-hidden />
                Загрузить снова
              </Button>
            </AlertDescription>
          </Alert>
        ) : (
          <Alert>
            <CircleAlert aria-hidden />
            <AlertTitle>В архиве пока нет выпусков</AlertTitle>
            <AlertDescription>
              Агенту не на что опереться. Постройте выпуск на странице «Выпуски» и вернитесь сюда.
            </AlertDescription>
          </Alert>
        )}
      </div>
    );
  }

  const missingDate = dateParam !== null && dateParam !== current.issue_date;

  return (
    <div className="space-y-6">
      {header}

      {missingDate && (
        <Alert>
          <CircleAlert aria-hidden />
          <AlertTitle>Выпуска с датой «{dateParam}» нет в архиве</AlertTitle>
          <AlertDescription>Показан последний выпуск — за {dayLabel(current.issue_date)}.</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start">
        <section className="flex min-w-0 flex-col gap-4" aria-label="Разговор с агентом">
          <div role="log" aria-live="polite" className="flex flex-col gap-4">
            {entries.length === 0 ? (
              <div className="flex items-start gap-3 rounded-xl border border-dashed px-4 py-5 text-sm text-muted-foreground">
                <MessageSquare className="mt-0.5 size-4 shrink-0" aria-hidden />
                <p>
                  По выпуску за {dayLabel(current.issue_date)} вопросов ещё не было. Спросите своими словами
                  или выберите готовый вопрос ниже.
                </p>
              </div>
            ) : (
              entries.map((e) => (
                <div key={e.id} className="wc-step flex flex-col gap-2">
                  <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-primary px-3.5 py-2 text-base break-words text-primary-foreground">
                    {e.question}
                  </div>
                  <div className="max-w-full sm:max-w-[92%]">
                    {e.state.kind === "pending" && <PendingCard />}
                    {e.state.kind === "done" && <AnswerCard answer={e.state.answer} />}
                    {e.state.kind === "unavailable" && (
                      <NoAnswer
                        tone="muted"
                        icon={<PlugZap aria-hidden />}
                        text="Ответ не получен: на сервере пока не включены ответы агента."
                        onRetry={() => void send(current.run_id, e.id, e.question)}
                        disabled={pending}
                      />
                    )}
                    {e.state.kind === "error" && (
                      <NoAnswer
                        tone="error"
                        icon={<CircleAlert aria-hidden />}
                        text={e.state.message}
                        onRetry={() => void send(current.run_id, e.id, e.question)}
                        disabled={pending}
                      />
                    )}
                  </div>
                </div>
              ))
            )}
          </div>

          <div ref={composerRef} className="scroll-mb-4 lg:sticky lg:bottom-4">
            <Card size="sm" className="gap-3 shadow-sm">
              <CardContent className="space-y-3">
                {unavailable && (
                  <Alert>
                    <PlugZap aria-hidden />
                    <AlertTitle>Ответы агента появятся, когда на сервере включён POST /api/ask</AlertTitle>
                    <AlertDescription>
                      Прогноз и журнал этого выпуска уже доступны:{" "}
                      <Link href={`/issues?date=${current.issue_date}`}>выпуски</Link>,{" "}
                      <Link href={`/agent?date=${current.issue_date}`}>журнал агента</Link>.
                    </AlertDescription>
                  </Alert>
                )}
                <div className="flex flex-wrap gap-2" aria-label="Готовые вопросы">
                  {SUGGESTED.map((q) => (
                    <Button
                      key={q}
                      variant="outline"
                      size="sm"
                      className="h-auto min-h-7 rounded-full py-1 text-left whitespace-normal"
                      disabled={pending}
                      onClick={() => ask(q)}
                    >
                      {q}
                    </Button>
                  ))}
                </div>
                <form onSubmit={onSubmit} className="flex gap-2">
                  <label htmlFor="ask-input" className="sr-only">
                    Вопрос агенту о выпуске за {dayLabel(current.issue_date)}
                  </label>
                  <Input
                    id="ask-input"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder={`Вопрос о выпуске за ${dayLabel(current.issue_date)}`}
                    maxLength={500}
                    autoComplete="off"
                    className="h-9"
                  />
                  <Button type="submit" size="lg" disabled={pending || !draft.trim()}>
                    {pending ? (
                      <LoaderCircle className="motion-safe:animate-spin" aria-hidden />
                    ) : (
                      <MessageSquare aria-hidden />
                    )}
                    Спросить
                  </Button>
                </form>
              </CardContent>
            </Card>
          </div>
        </section>

        <aside className="min-w-0">
          <IssueContext issue={current} />
        </aside>
      </div>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<PageSkeleton />}>
      <AskScreen />
    </Suspense>
  );
}

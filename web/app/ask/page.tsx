"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import {
  CircleAlert,
  CircleCheck,
  LoaderCircle,
  PlugZap,
  RotateCw,
  ScrollText,
  SendHorizontal,
  ServerOff,
  TriangleAlert,
} from "lucide-react";
import { ApiError, api, dayLabel, type AskAnswer, type IssueListItem } from "@/lib/api";
import { Explain, PageHeader } from "@/components/kit";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const START_API = "uv run uvicorn app.main:app --port 8000";

// Each chip hits a different intent of app/ask.py (peak, energy, band, recompute).
const SUGGESTED = [
  "Когда завтра пик ветра?",
  "Сколько энергии будет завтра?",
  "Можно ли верить прогнозу?",
  "Что изменилось в 12:00?",
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
  if (!(e instanceof ApiError)) return "Ответ не пришёл. Попробуйте ещё раз.";
  if (e.status === 0 || e.status >= 500) return `Сервис не отвечает. Запустите: ${START_API}`;
  return `Сервер не принял вопрос: ${e.message}`;
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
    <div className="space-y-3 text-base leading-relaxed">
      {toBlocks(text).map((b, i) =>
        b.kind === "p" ? (
          <p key={i}>{b.text}</p>
        ) : (
          <ul key={i} className="list-disc space-y-1.5 pl-5 marker:text-muted-foreground">
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

function AnswerLabel({ answer }: { answer: AskAnswer }) {
  if (answer.mode === "demo") {
    return (
      <span className="flex items-center gap-1.5">
        <ScrollText className="size-4" aria-hidden />
        ответ из журнала
      </span>
    );
  }
  return answer.grounded ? (
    <span className="flex items-center gap-1.5">
      <CircleCheck className="size-4" style={{ color: "var(--ok)" }} aria-hidden />
      ИИ-ответ, числа сверены
    </span>
  ) : (
    <span className="flex items-center gap-1.5">
      <TriangleAlert className="size-4" style={{ color: "var(--warn)" }} aria-hidden />
      ИИ-ответ, не все числа сверены
    </span>
  );
}

function AgentBubble({ children, busy }: { children: React.ReactNode; busy?: boolean }) {
  return (
    <div
      aria-busy={busy || undefined}
      className="max-w-full rounded-2xl rounded-bl-md bg-muted/60 px-5 py-4 sm:max-w-[90%]"
    >
      {children}
    </div>
  );
}

function Answer({ answer, date }: { answer: AskAnswer; date: string }) {
  const hasDetails = answer.sources.length > 0 || answer.fallback_reason;
  return (
    <div className="flex flex-col gap-2">
      <AgentBubble>
        <AnswerText text={answer.answer} />
      </AgentBubble>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 px-1 text-sm text-muted-foreground">
        <AnswerLabel answer={answer} />
        {hasDetails && (
          <details className="group">
            <summary className="cursor-pointer list-none hover:text-foreground [&::-webkit-details-marker]:hidden">
              Откуда ответ
            </summary>
            <div className="mt-2 space-y-2 break-words">
              {answer.sources.length > 0 && (
                <ul className="list-disc space-y-0.5 pl-5">
                  {answer.sources.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ul>
              )}
              {answer.fallback_reason && <p>ИИ не использовался: {answer.fallback_reason}</p>}
              <Link href={`/agent?date=${date}`} className="underline underline-offset-4 hover:text-foreground">
                Открыть журнал агента
              </Link>
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function Pending() {
  return (
    <div className="flex flex-col gap-2">
      <AgentBubble busy>
        <div className="space-y-2.5">
          <Skeleton className="h-4 w-64 max-w-full" />
          <Skeleton className="h-4 w-52 max-w-full" />
          <Skeleton className="h-4 w-40 max-w-full" />
        </div>
      </AgentBubble>
      <span className="flex items-center gap-1.5 px-1 text-sm text-muted-foreground">
        <LoaderCircle className="size-4 motion-safe:animate-spin" aria-hidden />
        читает журнал
      </span>
    </div>
  );
}

function NoAnswer({ icon, text, tone, onRetry, disabled }: {
  icon: React.ReactNode;
  text: string;
  tone: "muted" | "error";
  onRetry: () => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-1">
      <p
        className={cn(
          "flex items-start gap-2 text-sm break-words",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <span className="mt-0.5 shrink-0 [&_svg]:size-4">{icon}</span>
        <span className="min-w-0">{text}</span>
      </p>
      <Button variant="ghost" size="sm" onClick={onRetry} disabled={disabled}>
        <RotateCw aria-hidden />
        Спросить ещё раз
      </Button>
    </div>
  );
}

function PageSkeleton() {
  return (
    <div aria-busy="true">
      <div className="space-y-3 pb-8">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="h-5 w-full max-w-md" />
      </div>
      <div className="mx-auto flex w-full max-w-2xl flex-col gap-6 pt-6">
        <div className="grid gap-3 sm:grid-cols-2">
          {SUGGESTED.map((q) => (
            <Skeleton key={q} className="h-14 rounded-xl" />
          ))}
        </div>
        <Skeleton className="h-14 rounded-2xl" />
      </div>
    </div>
  );
}

// ---- screen ------------------------------------------------------------------------------------

const TITLE = "Вопрос агенту";
const LEAD = "Спросите про любой день — агент ответит по своему журналу";

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
  const seq = useRef(0);
  const composerRef = useRef<HTMLFormElement>(null);

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
      patch(runId, id, { kind: "done", answer });
    } catch (e) {
      patch(runId, id, isMissingEndpoint(e) ? { kind: "unavailable" } : { kind: "error", message: describeError(e) });
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

  if (issues === null) return <PageSkeleton />;

  if (!current) {
    return (
      <div>
        <PageHeader title={TITLE} lead={LEAD} />
        <div className="mx-auto max-w-2xl pt-6">
          {loadError ? (
            <Alert variant="destructive">
              <ServerOff aria-hidden />
              <AlertTitle>Сервис прогноза не запущен</AlertTitle>
              <AlertDescription>
                <p>
                  Запустите: <code className="font-mono">{START_API}</code>
                </p>
                {loadError.detail && <p>{loadError.detail}</p>}
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
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
              <AlertTitle>Прогнозов пока нет</AlertTitle>
              <AlertDescription>
                Постройте первый на странице <Link href="/issues">«Выпуски»</Link>.
              </AlertDescription>
            </Alert>
          )}
        </div>
      </div>
    );
  }

  const missingDate = dateParam !== null && dateParam !== current.issue_date;
  const runId = current.run_id;
  const date = current.issue_date;

  const picker = (
    <Select
      value={date}
      onValueChange={(v) => {
        if (typeof v === "string") router.replace(`/ask?date=${v}`, { scroll: false });
      }}
      items={Object.fromEntries(issues.map((i) => [i.issue_date, dayLabel(i.issue_date)]))}
    >
      <SelectTrigger className="w-40" aria-label="День">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {[...issues].reverse().map((i) => (
          <SelectItem key={i.issue_date} value={i.issue_date}>
            {dayLabel(i.issue_date)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  return (
    <div>
      <PageHeader title={TITLE} lead={LEAD} actions={picker} />

      <section aria-label="Разговор с агентом" className="mx-auto flex w-full max-w-2xl flex-col gap-10 pt-6 pb-10">
        {missingDate && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <CircleAlert className="size-4 shrink-0" aria-hidden />
            Дня {dateParam} нет — показан {dayLabel(date)}
          </p>
        )}

        {entries.length > 0 && (
          <div role="log" aria-live="polite" className="flex flex-col gap-10">
            {entries.map((e) => (
              <div key={e.id} className="wc-step flex flex-col gap-4">
                <div className="ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-primary px-4 py-2.5 text-base break-words text-primary-foreground">
                  {e.question}
                </div>
                {e.state.kind === "pending" && <Pending />}
                {e.state.kind === "done" && <Answer answer={e.state.answer} date={date} />}
                {e.state.kind === "unavailable" && (
                  <NoAnswer
                    tone="muted"
                    icon={<PlugZap aria-hidden />}
                    text="Ответы агента на сервере пока выключены."
                    onRetry={() => void send(runId, e.id, e.question)}
                    disabled={pending}
                  />
                )}
                {e.state.kind === "error" && (
                  <NoAnswer
                    tone="error"
                    icon={<CircleAlert aria-hidden />}
                    text={e.state.message}
                    onRetry={() => void send(runId, e.id, e.question)}
                    disabled={pending}
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div className="flex flex-col gap-4">
          <div
            aria-label="Готовые вопросы"
            className={cn(entries.length === 0 ? "grid gap-3 sm:grid-cols-2" : "flex flex-wrap gap-2")}
          >
            {SUGGESTED.map((q) => (
              <button
                key={q}
                type="button"
                disabled={pending}
                onClick={() => ask(q)}
                className={cn(
                  "border text-left transition-[background-color,transform] duration-150 ease-out outline-none",
                  "focus-visible:ring-3 focus-visible:ring-ring/50 active:scale-[0.98] disabled:opacity-50",
                  "[@media(hover:hover)_and_(pointer:fine)]:hover:bg-muted",
                  entries.length === 0
                    ? "rounded-xl px-4 py-3.5 text-base"
                    : "rounded-full px-3.5 py-1.5 text-sm text-muted-foreground",
                )}
              >
                {q}
              </button>
            ))}
          </div>

          <form
            ref={composerRef}
            onSubmit={onSubmit}
            className="flex scroll-mb-6 items-center gap-2 rounded-2xl border bg-card p-2 shadow-sm focus-within:ring-3 focus-within:ring-ring/40"
          >
            <label htmlFor="ask-input" className="sr-only">
              Вопрос агенту про {dayLabel(date)}
            </label>
            <Input
              id="ask-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Или напишите свой вопрос"
              maxLength={500}
              autoComplete="off"
              className="h-10 border-0 bg-transparent px-3 text-base shadow-none focus-visible:ring-0 md:text-base dark:bg-transparent"
            />
            <Button type="submit" className="h-10 shrink-0 rounded-xl px-4" disabled={pending || !draft.trim()}>
              {pending ? (
                <LoaderCircle className="motion-safe:animate-spin" aria-hidden />
              ) : (
                <SendHorizontal aria-hidden />
              )}
              Спросить
            </Button>
          </form>

          <div>
            <Explain label="Как это работает">
              <p>
                Агент отвечает только по журналу и прогнозу выбранного дня и не придумывает числа.
              </p>
              <p className="mt-2">
                «Ответ из журнала» — готовый ответ без ИИ. «ИИ-ответ, числа сверены» — текст написала
                языковая модель, каждое число проверено по журналу.
              </p>
            </Explain>
          </div>
        </div>
      </section>
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

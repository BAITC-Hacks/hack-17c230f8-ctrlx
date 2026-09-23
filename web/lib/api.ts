// Typed client of the WindCast API (FastAPI, app/schemas.py is the source of truth).
// All requests go to /api/* and are proxied to the Python service by next.config.ts.

export const RATED_MW = 5; // ВЭС «Нурлы»: 2 × Goldwind GW109/2500
export const STATION = "ВЭС «Нурлы»";

export type WxField = "day1" | "day2" | "day3" | "none";

export interface ForecastRow {
  issue_time_utc: string;
  issue_time_local: string;
  target_time_utc: string;
  target_time_local: string; // ISO with +05:00
  lead_h: number;
  horizon: "24h" | "48h";
  revision: number;
  power_t1: number;
  power_t2: number;
  power_farm: number;
  p10: number;
  p90: number;
  ws100_fc: number | null;
  wx_field: WxField;
  wx_model: string;
  model_name: string;
  fallback_used: boolean;
  run_id: string;
}

export interface ForecastIssue {
  issue_date: string;
  issue_time_utc: string;
  run_id: string;
  model_name: string;
  revision: number;
  fallback_used: boolean;
  rows: ForecastRow[];
  summary: string;
  warnings: string[];
}

export interface IssueListItem {
  issue_date: string;
  run_id: string;
  model_name: string;
  revisions: number;
  fallback_used: boolean;
}

export interface AgentStep {
  ts: string;
  run_id: string;
  issue_time: string;
  step: number;
  tool: string;
  args: Record<string, unknown>;
  status: "ok" | "warn" | "fail";
  summary: string;
  decision: string | null;
  reason: string | null;
  duration_ms: number;
  llm: { provider: string; model: string; tokens: number } | null;
}

export interface MetricRow {
  model: string;
  horizon: "24h" | "48h" | "all";
  mae: number;
  rmse: number;
  nmae: number; // already in percent
  bias: number;
  skill_vs_persistence: number | null;
  skill_vs_power_curve: number | null;
  n: number;
}

export interface MetricsReport {
  period: string;
  train_end: string;
  rows: MetricRow[];
  created_at: string;
  extras: {
    interval_p10_p90?: { coverage: number; mean_width: number; cqr_qhat: number };
    regulator_kpi_gbm?: Record<string, number>;
    imbalance_cost_upper_bound_mln_tg?: Record<string, number | string>;
    accuracy_1_minus_nmae_gbm?: number;
    recompute_t0_plus_12h?: Record<string, number | null>;
    [key: string]: unknown;
  };
}

export interface ReplayEvidence {
  month: string;
  issues: number;
  rows_scored: number;
  ablation: { variant: string; mae: number }[];
  decisions: {
    decision: string;
    fired: number;
    mean_delta_mae: number | null;
    ci95?: [number, number];
    wins?: number;
  }[];
}

export interface FaultsEvidence {
  issue: string;
  cases: {
    case: string;
    agent: { valid_hours: number; model?: string; decision?: string; reason?: string; error?: string };
    fixed_pipeline: { valid_hours: number; hours_from_broken_input?: number; error?: string };
  }[];
}

export interface Evidence {
  replay?: ReplayEvidence;
  faults?: FaultsEvidence;
}

export interface AskAnswer {
  answer: string;
  mode: "llm" | "demo";
  grounded: boolean;
  sources: string[];
  fallback_reason: string | null;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { cache: "no-store", ...init });
  } catch {
    throw new ApiError(0, "Сервис прогноза недоступен: запустите `uv run uvicorn app.main:app --port 8000`");
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = (await res.json()) as { detail?: unknown };
      if (typeof body.detail === "string") detail = body.detail;
    } catch {
      /* body was not JSON */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; mode: "llm" | "demo"; commit: string }>("/api/health"),
  issues: () => request<IssueListItem[]>("/api/issues"),
  forecast: (date: string) => request<ForecastIssue>(`/api/forecast/${date}`),
  log: (runId: string) => request<AgentStep[]>(`/api/runs/${encodeURIComponent(runId)}/log`),
  metrics: () => request<MetricsReport[]>("/api/metrics"),
  evidence: () => request<Evidence>("/api/evidence"),
  run: (date: string, refresh = false) =>
    request<{ run_id: string; issue: ForecastIssue }>("/api/run", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ issue_date: date, refresh }),
    }),
  ask: (runId: string, question: string) =>
    request<AskAnswer>("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ run_id: runId, question }),
    }),
};

// ---- derived views --------------------------------------------------------------------------

/** Latest value for each target hour of one issue: revision 1 wins where it exists. */
export function latestRows(rows: ForecastRow[]): ForecastRow[] {
  const byLead = new Map<number, ForecastRow>();
  for (const r of [...rows].sort((a, b) => a.revision - b.revision)) byLead.set(r.lead_h, r);
  return [...byLead.values()].sort((a, b) => a.lead_h - b.lead_h);
}

/** Day-ahead bid of an issue: hours 24–47 at revision 0 (filed before 08:00, before the recompute). */
export function bidRows(rows: ForecastRow[]): ForecastRow[] {
  return rows.filter((r) => r.revision === 0 && r.lead_h >= 24).sort((a, b) => a.lead_h - b.lead_h);
}

/** Plan of the current day of an issue: hours 0–23, latest revision. */
export function planRows(rows: ForecastRow[]): ForecastRow[] {
  return latestRows(rows).filter((r) => r.lead_h < 24);
}

// ---- formatting (local time strings already carry +05:00; no browser tz conversion) -----------

const MONTHS = ["января", "февраля", "марта", "апреля", "мая", "июня", "июля", "августа",
  "сентября", "октября", "ноября", "декабря"];

export const localDay = (iso: string) => iso.slice(0, 10);
export const localHour = (iso: string) => Number(iso.slice(11, 13));
export const hhmm = (iso: string) => iso.slice(11, 16);

export function dayLabel(isoOrDate: string): string {
  const [, m, d] = isoOrDate.slice(0, 10).split("-").map(Number);
  return `${d} ${MONTHS[m - 1]}`;
}

export function when(iso: string): string {
  return `${dayLabel(iso)}, ${hhmm(iso)}`;
}

const pctFmt = new Intl.NumberFormat("ru-RU", { maximumFractionDigits: 0 });
const numFmt = (digits: number) =>
  new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });

export const pct = (share: number) => `${pctFmt.format(share * 100)} %`;
export const mw = (share: number, digits = 1) => `${numFmt(digits).format(share * RATED_MW)} МВт`;
export const mwh = (value: number, digits = 1) => `${numFmt(digits).format(value)} МВт·ч`;
export const num = (value: number, digits = 3) => numFmt(digits).format(value);

export const WX_FIELD_LABEL: Record<WxField, string> = {
  day1: "прогон сутки назад",
  day2: "прогон двое суток назад",
  day3: "прогон трое суток назад",
  none: "без погоды (климатология)",
};

export const MODEL_LABEL: Record<string, string> = {
  gbm: "градиентный бустинг",
  power_curve: "кривая мощности",
  climatology: "климатология",
  persistence: "персистентность",
};

export const TOOL_LABEL: Record<string, string> = {
  plan: "План выпуска",
  fetch_weather: "Погода",
  validate_weather: "Проверка погоды",
  prepare: "Подготовка данных",
  run_model: "Модель",
  analyze: "Анализ результата",
  recompute_if_updated: "Пересчёт по свежему прогону",
  reflect: "Самопроверка",
  write_report: "Отчёт",
};

/** CSV text of a day-ahead bid in MWh (Astana time), ready to download. */
export function bidCsv(rows: ForecastRow[]): string {
  const lines = ["hour_astana,plan_mwh,p10_mwh,p90_mwh"];
  for (const r of rows) {
    const h = `${localDay(r.target_time_local)} ${hhmm(r.target_time_local)}`;
    lines.push([h, r.power_farm * RATED_MW, r.p10 * RATED_MW, r.p90 * RATED_MW]
      .map((v) => (typeof v === "number" ? v.toFixed(3) : v)).join(","));
  }
  return lines.join("\n") + "\n";
}

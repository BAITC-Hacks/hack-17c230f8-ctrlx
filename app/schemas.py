"""Contract (lead): data-frame columns, forecast rows, agent log lines, metrics, API."""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

# --- data frames (pandas), column names are the contract ---------------------------------------
# data/processed/hourly.parquet — one row per (time_utc, turbine)
HOURLY_COLUMNS = [
    "time_utc",  # tz-aware UTC, hour start
    "time_local",  # Asia/Almaty
    "turbine",  # 1 | 2
    "ws",  # mean nacelle wind speed, m/s
    "power",  # mean normalised active power, 0..1
    "temp",  # mean ambient temperature, °C
    "n_samples",  # 10-min samples in the hour (0..6)
    "flag_downtime",  # power ~0 while ws > 5 m/s
    "flag_gap",  # n_samples < MIN_SAMPLES_PER_HOUR -> ws/power/temp are NaN
]
# weather frame returned by app.weather.load_cached / fetch — one row per time_utc
WEATHER_COLUMNS = [
    "time_utc",
    "ws100_d1",
    "ws100_d2",
    "ws100_d3",  # wind_speed_100m_previous_dayN, m/s
    "ws10_d1",
    "ws10_d2",
    "ws10_d3",  # wind_speed_10m_previous_dayN, m/s
    "dir100_d2",  # wind_direction_100m_previous_day2, °
    "temp2m_d2",  # temperature_2m_previous_day2, °C
    "gust10_d2",  # wind_gusts_10m_previous_day2, m/s
]
# weather selected for one issue by app.weather.select_for_issue — one row per target hour
ISSUE_WEATHER_COLUMNS = [
    "target_time_utc",
    "lead_h",
    "wx_field",
    "wx_model",
    "ws100",
    "ws10",
    "dir100",
    "temp2m",
    "gust10",
]

WxField = Literal["day1", "day2", "day3"]
Horizon = Literal["24h", "48h"]
ModelName = Literal["persistence", "power_curve", "gbm", "climatology"]


# --- forecast (outputs/forecasts/issue_YYYY-MM-DD.csv, february_2026.csv) -----------------------
class ForecastRow(BaseModel):
    issue_time_utc: datetime
    issue_time_local: datetime
    target_time_utc: datetime
    target_time_local: datetime
    lead_h: int = Field(ge=0, le=47)
    horizon: Horizon
    revision: int = Field(ge=0, description="0 = at t0, 1 = intraday recompute at t0 + 12 h")
    power_t1: float = Field(ge=0, le=1)
    power_t2: float = Field(ge=0, le=1)
    power_farm: float = Field(ge=0, le=1, description="mean of the two turbines")
    p10: float = Field(ge=0, le=1)
    p90: float = Field(ge=0, le=1)
    ws100_fc: float
    wx_field: WxField
    wx_model: str
    model_name: ModelName
    fallback_used: bool = False
    run_id: str


FORECAST_COLUMNS = list(ForecastRow.model_fields)


class ForecastIssue(BaseModel):
    issue_date: date = Field(description="observation day D; t0 = D+1 00:00 local")
    issue_time_utc: datetime
    run_id: str
    model_name: ModelName
    revision: int
    fallback_used: bool
    rows: list[ForecastRow]
    summary: str = Field(description="dispatcher summary in Russian (template or LLM)")
    warnings: list[str] = []


# --- agent log (runs/<run_id>/agent_log.jsonl, one line per step) -------------------------------
class LlmInfo(BaseModel):
    provider: str
    model: str
    tokens: int = 0


class AgentStep(BaseModel):
    ts: datetime
    run_id: str
    issue_time: datetime
    step: int
    tool: str
    args: dict = {}
    status: Literal["ok", "warn", "fail"]
    summary: str
    decision: str | None = None
    reason: str | None = None
    duration_ms: int = 0
    llm: LlmInfo | None = None


# --- metrics (outputs/metrics/*.json) ------------------------------------------------------------
class MetricRow(BaseModel):
    model: ModelName
    horizon: Horizon | Literal["all"]
    mae: float
    rmse: float
    nmae: float = Field(description="MAE as % of rated power (power is normalised to 1)")
    bias: float
    skill_vs_persistence: float | None = None
    skill_vs_power_curve: float | None = None
    n: int


class MetricsReport(BaseModel):
    period: str = Field(description="e.g. 2026-01 or 2025-02")
    train_end: date
    rows: list[MetricRow]
    created_at: datetime
    extras: dict = Field(default_factory=dict, description="coverage, recompute effect, KPIs")


# --- API ------------------------------------------------------------------------------------------
class RunRequest(BaseModel):
    issue_date: date
    refresh: bool = False
    llm: bool = False


class RunResponse(BaseModel):
    run_id: str
    issue: ForecastIssue
    log_path: str
    report_path: str


class IssueListItem(BaseModel):
    issue_date: date
    run_id: str
    model_name: ModelName
    revisions: int
    fallback_used: bool


# --- "ask the agent": grounded Q&A over one run (app/ask.py) -----------------------------------
class AskRequest(BaseModel):
    run_id: str
    question: str = Field(min_length=2, max_length=500)


class AskAnswer(BaseModel):
    answer: str
    mode: Literal["llm", "demo"]
    grounded: bool = Field(description="every number in the answer exists in the run facts")
    sources: list[str] = Field(default_factory=list, description="log steps / rows used")
    fallback_reason: str | None = None

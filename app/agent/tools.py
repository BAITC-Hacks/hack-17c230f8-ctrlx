"""Agent tools (lead's zone). Each tool is a plain function with a JSON-serialisable result,
so the same set is used by the deterministic orchestrator and by the LLM planner (function calling).

Implementations call into the team modules: app.data (Амирхан), app.weather (Ансар),
app.models / app.features (Амирхан). Until those land, the tools work on the contract only.
"""

from datetime import date, datetime

import pandas as pd

TOOL_SPECS: list[dict] = []  # filled by @tool for the LLM planner (name, description, JSON schema)


def tool(description: str, parameters: dict):
    def wrap(fn):
        TOOL_SPECS.append(
            {"name": fn.__name__, "description": description, "parameters": parameters}
        )
        return fn

    return wrap


@tool("Load cached (or fetch) weather forecasts for the farm coordinates", {"type": "object"})
def fetch_weather(model: str = "best_match", refresh: bool = False) -> pd.DataFrame:
    raise NotImplementedError("R2: app.weather.load_or_fetch")


@tool("Check coverage, ranges and the leakage rule for one issue", {"type": "object"})
def validate_weather(
    wx: pd.DataFrame, issue_time_utc: datetime, hours_since_issue: int = 0
) -> dict:
    raise NotImplementedError("R5")


@tool("Build the hourly observation table and the feature matrix for one issue", {"type": "object"})
def prepare(issue_date: date, wx_issue: pd.DataFrame) -> pd.DataFrame:
    raise NotImplementedError("R1/R3: app.data + app.features")


@tool("Run a forecasting model (persistence | power_curve | gbm)", {"type": "object"})
def run_model(model_name: str, features: pd.DataFrame) -> pd.DataFrame:
    raise NotImplementedError("R3: app.models")


@tool(
    "Sanity-check a forecast: range, jumps, spread, disagreement with the baseline",
    {"type": "object"},
)
def analyze(forecast: pd.DataFrame, baseline: pd.DataFrame | None) -> dict:
    raise NotImplementedError("R5")


@tool("Recompute the remaining hours if fresher weather runs became available", {"type": "object"})
def recompute_if_updated(issue_date: date, previous: pd.DataFrame, hours_since_issue: int) -> dict:
    raise NotImplementedError("R5")


@tool("Write report.md for the run", {"type": "object"})
def write_report(run_id: str, forecast: pd.DataFrame, checks: dict) -> str:
    raise NotImplementedError("R5")

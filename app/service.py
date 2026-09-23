"""Entry points shared by the CLI and the API: one issue, the sequential test-period backtest."""

from datetime import date, timedelta

import pandas as pd

from app.agent.orchestrator import run_issue
from app.config import (
    FEBRUARY_PATH,
    OUTPUTS_FORECASTS,
    RATED_MW,
    TEST_ISSUE_FIRST,
    TEST_ISSUE_LAST,
)
from app.schemas import ForecastIssue


def forecast(
    issue_date: date, *, refresh: bool = False, llm: bool = False, demo_dir=None
) -> ForecastIssue:
    if demo_dir is not None:  # e.g. runs/llm_demo: keep the committed test outputs untouched
        return run_issue(
            issue_date,
            refresh=refresh,
            llm=llm,
            out_dir=demo_dir / "forecasts",
            runs_dir=demo_dir / "runs",
        )
    return run_issue(issue_date, refresh=refresh, llm=llm)


def backtest(
    start: date = TEST_ISSUE_FIRST, end: date = TEST_ISSUE_LAST, *, refresh: bool = False
) -> list[ForecastIssue]:
    """Issues one after another, as if the agent woke up every night of the test period."""
    issues: list[ForecastIssue] = []
    d = start
    while d <= end:
        issues.append(forecast(d, refresh=refresh))
        d += timedelta(days=1)
    write_february(issues)
    return issues


def write_february(issues: list[ForecastIssue]) -> pd.DataFrame:
    """february_2026.csv: one row per hour of the test month.

    power_farm_plan — the latest forecast for the hour (lead 0-23 of the issue made at the start of
    that day, revision 1 where the intraday recompute happened); power_farm_bid — the day-ahead bid
    (lead 24-47 of the previous night's issue, ready before the 08:00 gate). Full provenance of
    every issue and revision stays in outputs/forecasts/issue_*.csv.
    """
    rows = pd.DataFrame([r.model_dump(mode="json") for i in issues for r in i.rows])
    rows["target"] = pd.to_datetime(rows["target_time_utc"], utc=True)
    plan = (
        rows[rows["lead_h"] < 24]
        .sort_values(["target", "revision"])
        .drop_duplicates("target", keep="last")
        .set_index("target")
    )
    bid = rows[(rows["lead_h"] >= 24) & (rows["revision"] == 0)].set_index("target")
    hours = pd.date_range(plan.index.min(), plan.index.max(), freq="h", tz="UTC")
    out = pd.DataFrame(index=hours)
    out.index.name = "target_time_utc"
    out["target_time_local"] = [t.tz_convert("Asia/Almaty").isoformat() for t in hours]
    for col in ("power_farm", "power_t1", "power_t2", "p10", "p90"):
        out[f"{col}_plan"] = plan[col].reindex(hours)
    out["plan_revision"] = plan["revision"].reindex(hours)
    out["plan_run_id"] = plan["run_id"].reindex(hours)
    out["power_farm_bid"] = bid["power_farm"].reindex(hours)
    out["bid_run_id"] = bid["run_id"].reindex(hours)
    out["plan_mw"] = (out["power_farm_plan"] * RATED_MW).round(3)
    out["bid_mw"] = (out["power_farm_bid"] * RATED_MW).round(3)
    OUTPUTS_FORECASTS.mkdir(parents=True, exist_ok=True)
    out.reset_index().to_csv(FEBRUARY_PATH, index=False, lineterminator="\n")
    return out

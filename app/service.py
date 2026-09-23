"""Entry points shared by the CLI and the API: one issue, the sequential test-period backtest."""

import math
from datetime import date, timedelta
from pathlib import Path
from tempfile import NamedTemporaryFile

import pandas as pd

from app.agent.orchestrator import run_issue
from app.agent.storage import issue_lock
from app.config import (
    FEBRUARY_PATH,
    OUTPUTS_FORECASTS,
    RATED_MW,
    TEST_ISSUE_FIRST,
    TEST_ISSUE_LAST,
)
from app.features import issue_time_utc
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
    """Sequential issues; only the complete test period replaces february_2026.csv.

    Other ranges publish range_<start>_<end>.csv. Return the calculated issues;
    aggregate_path(start, end) identifies their aggregate artifact.
    """
    if start > end:
        raise ValueError("Начало периода не может быть позже конца")
    issues: list[ForecastIssue] = []
    d = start
    while d <= end:
        issues.append(forecast(d, refresh=refresh))
        d += timedelta(days=1)
    _write_aggregate(issues, start, end, aggregate_path(start, end))
    return issues


def aggregate_path(start: date, end: date) -> Path:
    """Canonical filename is reserved for all 28 test issues; partial results stay separate."""
    if (start, end) == (TEST_ISSUE_FIRST, TEST_ISSUE_LAST):
        return FEBRUARY_PATH
    return OUTPUTS_FORECASTS / f"range_{start.isoformat()}_{end.isoformat()}.csv"


def write_february(issues: list[ForecastIssue]) -> pd.DataFrame:
    """Require the complete test period and atomically write all 672 February hours.

    Return the aggregate with attrs['output_path'] naming the published file.
    """
    return _write_aggregate(issues, TEST_ISSUE_FIRST, TEST_ISSUE_LAST, FEBRUARY_PATH)


def _write_aggregate(
    issues: list[ForecastIssue],
    start: date,
    end: date,
    path: Path,
) -> pd.DataFrame:
    """Validate complete requested coverage before replacing any existing aggregate.

    power_farm_plan — the latest forecast for the hour (lead 0-23 of the issue made at the start of
    that day, revision 1 where the intraday recompute happened); power_farm_bid — the day-ahead bid
    (lead 24-47 of the previous night's issue, ready before the 08:00 gate). Full provenance of
    every issue and revision stays in outputs/forecasts/issue_*.csv.
    """
    if start > end or not issues:
        raise ValueError("Нельзя сохранить пустой или обратный период прогнозирования")
    expected_dates = [start + timedelta(days=i) for i in range((end - start).days + 1)]
    if sorted(issue.issue_date for issue in issues) != expected_dates:
        raise ValueError("Набор выпусков должен точно покрывать заданный период без повторов")
    powers = ("power_farm", "power_t1", "power_t2", "p10", "p90")
    for issue in issues:
        initial = [row for row in issue.rows if row.revision == 0]
        if sorted(row.lead_h for row in initial) != list(range(48)):
            raise ValueError(f"Выпуск {issue.issue_date} не содержит полного исходного горизонта")
        if len({(row.revision, row.lead_h) for row in issue.rows}) != len(issue.rows):
            raise ValueError(f"Выпуск {issue.issue_date} содержит повторные часы одной ревизии")
        t0 = issue_time_utc(issue.issue_date)
        for row in issue.rows:
            if (
                row.issue_time_utc != t0
                or row.target_time_utc != t0 + timedelta(hours=row.lead_h)
                or row.run_id != issue.run_id
            ):
                raise ValueError(
                    f"Выпуск {issue.issue_date} содержит несогласованные часы или run_id"
                )
            if not all(math.isfinite(getattr(row, column)) for column in powers):
                raise ValueError(f"Выпуск {issue.issue_date} содержит нечисловую мощность")
    rows = pd.DataFrame([r.model_dump(mode="json") for i in issues for r in i.rows])
    rows["target"] = pd.to_datetime(rows["target_time_utc"], utc=True)
    plan = (
        rows[rows["lead_h"] < 24]
        .sort_values(["target", "revision"])
        .drop_duplicates("target", keep="last")
        .set_index("target")
    )
    bid = rows[(rows["lead_h"] >= 24) & (rows["revision"] == 0)].set_index("target")
    hours = pd.date_range(issue_time_utc(start), periods=len(expected_dates) * 24, freq="h")
    if not plan.index.equals(hours):
        raise ValueError("Оперативный прогноз содержит пропущенные или лишние часы")
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
    with issue_lock(path.parent, f"aggregate:{path.name}"):
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                newline="\n",
                dir=path.parent,
                prefix=".aggregate-",
                suffix=".csv",
                delete=False,
            ) as stream:
                temporary = Path(stream.name)
                out.reset_index().to_csv(stream, index=False, lineterminator="\n")
            temporary.replace(path)
        finally:
            if temporary is not None:
                temporary.unlink(missing_ok=True)
    out.attrs["output_path"] = str(path)
    return out

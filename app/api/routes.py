"""HTTP endpoints (Ансар, R8). Mounted by app/main.py under the /api prefix.

Contract: GET /issues -> list[IssueListItem]; GET /forecast/{issue_date} -> ForecastIssue;
GET /metrics -> list[MetricsReport]; GET /runs/{run_id}/log -> list[AgentStep];
POST /run (RunRequest) -> RunResponse.

Everything except POST /run is read off disk: `outputs/forecasts/issue_*.csv`,
`runs/<run_id>/{agent_log.jsonl,report.md}` and `outputs/metrics/*.json`. Those paths belong to
the lead's zone -- read-only here. That split is deliberate: the read path has no dependency on
the model stack, so the API and the page keep working wherever the agent itself cannot run.
"""

import csv
import json
import logging
from datetime import date
from pathlib import Path

from fastapi import APIRouter, HTTPException
from pydantic import ValidationError

from app.agent.log import RunLog
from app.config import OUTPUTS_FORECASTS, OUTPUTS_METRICS, RUNS_DIR
from app.schemas import (
    AgentStep,
    ForecastIssue,
    ForecastRow,
    IssueListItem,
    MetricsReport,
    RunRequest,
    RunResponse,
)

log = logging.getLogger(__name__)
router = APIRouter()

ISSUE_PREFIX = "issue_"
AGENT_UNAVAILABLE = (
    "агент недоступен на этой машине: не загружается библиотека моделей. "
    "Чтение готовых выпусков и страница работают; см. README → «Ограничения»."
)


def run_forecast(issue_date, *, refresh: bool = False, llm: bool = False):
    """Indirection to the agent, kept at module level so tests can substitute it.

    `app.service` is imported inside the call, not at module import: it pulls in the model
    stack, whose native libraries may be missing on a given OS (LightGBM needs an OpenMP
    runtime that no lockfile can install). Everything else this router serves is read off
    disk, so the API, the page and their tests must not die because a model library does not
    load — only POST /run degrades, to a 503.
    """
    from app.service import forecast

    return forecast(issue_date, refresh=refresh, llm=llm)


def _issue_path(issue_date: date):
    return OUTPUTS_FORECASTS / f"{ISSUE_PREFIX}{issue_date.isoformat()}.csv"


def _read_rows(path) -> list[ForecastRow]:
    """Parse one forecast CSV. A malformed file is a 500, not a silent empty issue."""
    with path.open(encoding="utf-8", newline="") as f:
        raw = list(csv.DictReader(f))
    try:
        return [ForecastRow.model_validate(row) for row in raw]
    except ValidationError as exc:
        # str(ValidationError) echoes input_value of every bad field: that is server file
        # content, so it stays in the server log and never goes out in the response
        log.exception("%s: не соответствует контракту ForecastRow", path.name)
        raise HTTPException(
            status_code=500, detail=f"{path.name}: файл повреждён или не соответствует контракту"
        ) from exc


def _latest(rows: list[ForecastRow]) -> ForecastRow:
    """Representative row for issue-level fields: the newest revision, lowest lead."""
    return max(rows, key=lambda r: (r.revision, -r.lead_h))


def _run_dir(run_id: str) -> Path | None:
    """The run's directory, or None when `run_id` does not name one directly under runs/.

    Single place that contains a run_id before it becomes a filesystem path: it arrives either
    from the URL or from a forecast CSV, and neither is validated elsewhere. "." resolves to
    runs/ itself, which is inside runs/ but is not a run; ".." escapes it.
    """
    run_dir = (RUNS_DIR / run_id).resolve()
    if run_dir.parent != RUNS_DIR.resolve() or not run_dir.is_dir():
        return None
    return run_dir


def _read_log(run_id: str) -> list[AgentStep]:
    """Agent steps for a run. A malformed JSONL line is a 500 naming the file, not a bare crash."""
    try:
        return RunLog.read(run_id)
    except ValidationError as exc:
        log.exception("runs/%s/agent_log.jsonl: не соответствует контракту AgentStep", run_id)
        raise HTTPException(
            status_code=500, detail=f"runs/{run_id}/agent_log.jsonl: файл повреждён"
        ) from exc


def _read_summary(run_id: str) -> str:
    run_dir = _run_dir(run_id)
    if run_dir is None:
        return ""
    report = run_dir / "report.md"
    return report.read_text(encoding="utf-8").strip() if report.exists() else ""


@router.get("/issues")
def list_issues() -> list[IssueListItem]:
    """Every forecast issue on disk, oldest first. Empty list before the first run."""
    items: list[IssueListItem] = []
    for path in sorted(OUTPUTS_FORECASTS.glob(f"{ISSUE_PREFIX}*.csv")):
        try:
            issue_date = date.fromisoformat(path.stem[len(ISSUE_PREFIX) :])
        except ValueError:
            continue  # not an issue file (e.g. february_2026.csv)
        rows = _read_rows(path)
        if not rows:
            continue
        head = _latest(rows)
        items.append(
            IssueListItem(
                issue_date=issue_date,
                run_id=head.run_id,
                model_name=head.model_name,
                revisions=len({r.revision for r in rows}),
                fallback_used=any(r.fallback_used for r in rows),
            )
        )
    return items


@router.get("/forecast/{issue_date}")
def get_forecast(issue_date: date) -> ForecastIssue:
    """One issue: 48 hourly rows plus the dispatcher summary from the run's report.md."""
    path = _issue_path(issue_date)
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"выпуск {issue_date.isoformat()} не найден")
    rows = _read_rows(path)
    if not rows:
        raise HTTPException(status_code=404, detail=f"выпуск {issue_date.isoformat()} пуст")

    head = _latest(rows)
    # The forecast itself does not depend on the log: a corrupt log must not hide a valid issue
    # (this is the main scenario). /runs/{id}/log, where the log IS the payload, still 500s.
    try:
        steps = _read_log(head.run_id)
        warnings = [
            f"шаг {s.step} ({s.tool}): {s.reason or s.summary}"
            for s in steps
            if s.status in ("warn", "fail")
        ]
    except HTTPException:
        warnings = [f"журнал прогона {head.run_id} повреждён — замечания агента не прочитаны"]
    return ForecastIssue(
        issue_date=issue_date,
        issue_time_utc=head.issue_time_utc,
        run_id=head.run_id,
        model_name=head.model_name,
        revision=head.revision,
        fallback_used=any(r.fallback_used for r in rows),
        rows=rows,
        summary=_read_summary(head.run_id),
        warnings=warnings,
    )


@router.get("/runs/{run_id}/log")
def get_run_log(run_id: str) -> list[AgentStep]:
    """Agent steps for one run. 404 when the run directory is missing or outside runs/.

    `run_id` comes straight from the URL and is used to build a filesystem path, so it must be
    contained: the router rejects a literal "/", but a percent-encoded ".." arrives decoded and
    would otherwise resolve above RUNS_DIR.
    """
    if _run_dir(run_id) is None:
        raise HTTPException(status_code=404, detail=f"прогон {run_id} не найден")
    return _read_log(run_id)


@router.get("/metrics")
def get_metrics() -> list[MetricsReport]:
    """Backtest metrics, newest first. Empty while the lead is still computing them."""
    reports: list[MetricsReport] = []
    for path in sorted(OUTPUTS_METRICS.glob("*.json")):
        try:
            reports.append(MetricsReport.model_validate_json(path.read_text(encoding="utf-8")))
        except (ValidationError, json.JSONDecodeError) as exc:
            log.exception("%s: не соответствует контракту MetricsReport", path.name)
            raise HTTPException(
                status_code=500,
                detail=f"{path.name}: файл повреждён или не соответствует контракту",
            ) from exc
    # by period, not created_at: the order must not depend on which evaluate ran last
    reports.sort(key=lambda r: r.period, reverse=True)
    return reports


@router.get("/evidence")
def get_evidence() -> dict:
    """Agentic evidence written by `app.cli replay` / `app.cli faults`, served as-is.

    Deliberately not typed against app/schemas.py: these files are measurement output, not a
    contract other modules build on, and their shape is owned by the CLI that produces them.
    Missing files mean the evidence was not generated yet -- the page renders an empty state.
    """
    out: dict = {}
    for key, pattern in (("replay", "replay_*.json"), ("faults", "faults.json")):
        for path in sorted((OUTPUTS_FORECASTS.parent / "evidence").glob(pattern)):
            try:
                out[key] = json.loads(path.read_text(encoding="utf-8"))
            except json.JSONDecodeError as exc:
                log.exception("%s: не разбирается как JSON", path.name)
                raise HTTPException(
                    status_code=500, detail=f"{path.name}: файл повреждён"
                ) from exc
    return out


@router.post("/run")
def post_run(request: RunRequest) -> RunResponse:
    """Trigger one issue through the agent. 503 while the agent cannot run on this machine."""
    try:
        issue = run_forecast(request.issue_date, refresh=request.refresh, llm=request.llm)
    except (ImportError, OSError) as exc:
        # the model stack does not load on this OS -- reading finished issues still works
        raise HTTPException(status_code=503, detail=AGENT_UNAVAILABLE) from exc
    return RunResponse(
        run_id=issue.run_id,
        issue=issue,
        log_path=str((RUNS_DIR / issue.run_id / "agent_log.jsonl").relative_to(RUNS_DIR.parent)),
        report_path=str((RUNS_DIR / issue.run_id / "report.md").relative_to(RUNS_DIR.parent)),
    )

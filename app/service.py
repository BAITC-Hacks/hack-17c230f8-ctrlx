"""Entry points shared by the CLI and the API: one issue, a sequential backtest, LLM on/off."""

from datetime import date, timedelta

from app.agent.orchestrator import run_issue
from app.config import TEST_ISSUE_FIRST, TEST_ISSUE_LAST
from app.schemas import ForecastIssue


def forecast(issue_date: date, *, refresh: bool = False, llm: bool = False) -> ForecastIssue:
    if llm:
        from app.agent.llm_planner import run_issue_llm  # optional: needs LLM_API_KEY

        return run_issue_llm(issue_date, refresh=refresh)
    return run_issue(issue_date, refresh=refresh)


def backtest(
    start: date = TEST_ISSUE_FIRST, end: date = TEST_ISSUE_LAST, *, refresh: bool = False
) -> list[ForecastIssue]:
    issues: list[ForecastIssue] = []
    d = start
    while d <= end:
        issues.append(forecast(d, refresh=refresh))
        d += timedelta(days=1)
    return issues

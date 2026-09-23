"""Deterministic agent loop (default, no keys):
plan -> fetch_weather -> validate_weather -> prepare -> run_model -> analyze -> [self-correct]
-> recompute_if_updated -> write_report. Every step goes to RunLog; decisions carry a reason.
"""

from datetime import date

from app.schemas import ForecastIssue


def run_issue(issue_date: date, *, refresh: bool = False, model_name: str = "gbm") -> ForecastIssue:
    raise NotImplementedError("R4/R5: implemented by the lead after the contract")

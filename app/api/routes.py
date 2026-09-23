"""HTTP endpoints (Ансар, R8). Mounted by app/main.py under the /api prefix.

Contract: GET /issues -> list[IssueListItem]; GET /forecast/{issue_date} -> ForecastIssue;
GET /metrics -> list[MetricsReport]; GET /runs/{run_id}/log -> list[AgentStep];
POST /run (RunRequest) -> RunResponse.
"""

from fastapi import APIRouter

router = APIRouter()


@router.get("/issues")
def list_issues() -> list:
    return []

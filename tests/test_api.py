from fastapi.testclient import TestClient

from app.config import HORIZON_H
from app.main import app

client = TestClient(app)

SAMPLE_DATE = "2026-01-31"
SAMPLE_RUN = "20260201T0000-sample"


def test_health_reports_demo_mode_without_key(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body == {"ok": True, "mode": "demo", "commit": "dev"}


def test_issues_endpoint_returns_list():
    response = client.get("/api/issues")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_index_page_served_as_html():
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


# --- R8: issues / forecast / log / metrics / run, against the sample issue in the repo ----------
def test_issues_include_the_sample_issue():
    items = client.get("/api/issues").json()
    sample = [i for i in items if i["issue_date"] == SAMPLE_DATE]
    assert len(sample) == 1, f"ожидался ровно один выпуск {SAMPLE_DATE}, получено {len(sample)}"
    assert sample[0]["run_id"] == SAMPLE_RUN
    assert sample[0]["revisions"] >= 1


def test_forecast_returns_full_horizon():
    response = client.get(f"/api/forecast/{SAMPLE_DATE}")
    assert response.status_code == 200
    issue = response.json()
    assert len(issue["rows"]) == HORIZON_H
    assert [r["lead_h"] for r in issue["rows"]] == list(range(HORIZON_H))
    assert issue["run_id"] == SAMPLE_RUN
    assert issue["summary"], "summary должен приходить из runs/<run_id>/report.md"


def test_forecast_rows_carry_the_leakage_field():
    """Every row must say which previous_dayN it used -- that is the anti-leakage evidence."""
    rows = client.get(f"/api/forecast/{SAMPLE_DATE}").json()["rows"]
    assert all(r["wx_field"] in ("day1", "day2", "day3") for r in rows)
    assert all(r["horizon"] == ("24h" if r["lead_h"] < 24 else "48h") for r in rows)


def test_forecast_warnings_come_from_the_agent_log():
    issue = client.get(f"/api/forecast/{SAMPLE_DATE}").json()
    assert issue["warnings"], "в образце лога есть шаги со статусом warn"


def test_forecast_unknown_date_is_404():
    assert client.get("/api/forecast/2026-03-01").status_code == 404


def test_run_log_has_the_agent_steps():
    response = client.get(f"/api/runs/{SAMPLE_RUN}/log")
    assert response.status_code == 200
    steps = response.json()
    assert len(steps) >= 7
    assert [s["step"] for s in steps] == list(range(1, len(steps) + 1))
    assert all(s["status"] in ("ok", "warn", "fail") for s in steps)
    assert steps[0]["tool"] == "plan"


def test_run_log_unknown_run_is_404():
    assert client.get("/api/runs/does-not-exist/log").status_code == 404


def test_metrics_is_a_list_before_the_backtest():
    response = client.get("/api/metrics")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_post_run_is_503_until_the_agent_is_wired():
    response = client.post("/api/run", json={"issue_date": SAMPLE_DATE})
    assert response.status_code == 503
    assert "агент" in response.json()["detail"]

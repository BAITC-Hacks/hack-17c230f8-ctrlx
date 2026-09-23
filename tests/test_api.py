from pathlib import Path

from fastapi.testclient import TestClient

from app.config import CORRECTION_MIN_LEAD_H, HORIZON_H
from app.main import app

client = TestClient(app)
PROJECT_ROOT = Path(__file__).resolve().parent.parent

SAMPLE_DATE = "2026-01-31"


def _run_id() -> str:
    """run_id of the committed first test issue (the agent's output, not a hand-made sample)."""
    items = [i for i in client.get("/api/issues").json() if i["issue_date"] == SAMPLE_DATE]
    return items[0]["run_id"]


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
    assert sample[0]["run_id"].startswith("20260201T0000-")
    assert sample[0]["revisions"] >= 1


def test_forecast_returns_full_horizon():
    response = client.get(f"/api/forecast/{SAMPLE_DATE}")
    assert response.status_code == 200
    issue = response.json()
    # rows carry every revision: rev 0 = full horizon at t0, rev 1 = recompute of the rest
    rev0 = [r for r in issue["rows"] if r["revision"] == 0]
    assert [r["lead_h"] for r in rev0] == list(range(HORIZON_H))
    assert all(r["lead_h"] >= CORRECTION_MIN_LEAD_H for r in issue["rows"] if r["revision"] == 1)
    assert issue["run_id"] == _run_id()
    assert issue["summary"], "summary должен приходить из runs/<run_id>/report.md"


def test_forecast_rows_carry_the_leakage_field():
    """Every row must say which previous_dayN it used -- that is the anti-leakage evidence."""
    rows = client.get(f"/api/forecast/{SAMPLE_DATE}").json()["rows"]
    assert all(r["wx_field"] in ("day1", "day2", "day3") for r in rows)
    assert all(r["horizon"] == ("24h" if r["lead_h"] < 24 else "48h") for r in rows)


def test_forecast_warnings_come_from_the_agent_log():
    issue = client.get(f"/api/forecast/{SAMPLE_DATE}").json()
    steps = client.get(f"/api/runs/{_run_id()}/log").json()
    flagged = [s for s in steps if s["status"] in ("warn", "fail")]
    assert len(issue["warnings"]) == len(flagged)


def test_forecast_unknown_date_is_404():
    assert client.get("/api/forecast/2026-03-01").status_code == 404


def test_run_log_has_the_agent_steps():
    response = client.get(f"/api/runs/{_run_id()}/log")
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


def test_post_run_runs_the_agent(monkeypatch, tmp_path):
    """POST /run goes through the real agent; outputs go to a temp dir, the repo stays clean."""
    from datetime import date

    from app.agent.orchestrator import run_issue
    from app.api import routes

    def run_in_tmp(issue_date: date, refresh: bool = False, llm: bool = False):
        return run_issue(issue_date, out_dir=tmp_path / "f", runs_dir=tmp_path / "r")

    monkeypatch.setattr(routes, "run_forecast", run_in_tmp)
    response = client.post("/api/run", json={"issue_date": SAMPLE_DATE})
    assert response.status_code == 200
    body = response.json()
    assert len([r for r in body["issue"]["rows"] if r["revision"] == 0]) == HORIZON_H


# --- containment: run_id comes from the URL and becomes a filesystem path -----------------------
def test_run_log_rejects_paths_outside_runs():
    """A percent-encoded ".." arrives decoded, so is_dir() alone is not enough."""
    for attack in ("%2e%2e", "..", "%2e", "~", "%2e%2e%2f%2e%2e", "runs"):
        response = client.get(f"/api/runs/{attack}/log")
        assert response.status_code == 404, f"{attack} дал {response.status_code}, а не 404"


def test_page_escapes_api_text_before_innerhtml():
    """The dispatcher summary and the agent's own strings reach innerHTML: they must be escaped.

    Guards the escaper itself -- a browser test is out of scope here, so this pins the contract
    that every interpolation of agent-written text goes through esc().
    """
    page = (PROJECT_ROOT / "static" / "index.html").read_text(encoding="utf-8")
    assert "const esc = (s) =>" in page, "экранирование удалено из страницы"
    for sink in ("esc(s.summary)", "esc(s.decision)", "esc(w)", "esc(l.replace"):
        assert sink in page, f"текст из API попадает в innerHTML без esc(): {sink}"

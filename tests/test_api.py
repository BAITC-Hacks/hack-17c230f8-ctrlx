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
    for prefix in ("LLM", "LLM_FALLBACK"):  # .env.local may hold real keys on a dev machine
        monkeypatch.delenv(f"{prefix}_API_KEY", raising=False)
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


def test_issues_skips_an_unreadable_file_instead_of_failing(monkeypatch, tmp_path):
    """One corrupt forecast file must not hide every other issue: the page needs the list."""
    from app.api import routes

    good = tmp_path / "issue_2026-01-31.csv"
    good.write_text(
        (routes.OUTPUTS_FORECASTS / "issue_2026-01-31.csv").read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    broken = tmp_path / "issue_2026-02-01.csv"
    broken.write_text("issue_time_utc,lead_h\nбитая,999\n", encoding="utf-8")
    monkeypatch.setattr(routes, "OUTPUTS_FORECASTS", tmp_path)

    response = client.get("/api/issues")
    assert response.status_code == 200
    dates = [i["issue_date"] for i in response.json()]
    assert dates == ["2026-01-31"], f"ожидался только читаемый выпуск, получено {dates}"


def test_ask_answers_from_the_issue_journal():
    response = client.post(
        "/api/ask", json={"run_id": _run_id(), "question": "Почему пересчитали?"}
    )
    assert response.status_code == 200
    body = response.json()
    assert body["answer"] and body["mode"] in ("llm", "demo")


def test_dispatcher_rejects_stale_requests_and_exports_all_revisions():
    """R8: run the shipped JS with delayed HTTP responses; Node is optional for Python users."""
    import shutil
    import subprocess

    import pytest

    node = shutil.which("node")
    if not node:
        pytest.skip("Node required only for the lightweight UI regression check")
    script = r'''
const fs = require('node:fs'), vm = require('node:vm'), assert = require('node:assert/strict');
const page = fs.readFileSync('static/index.html', 'utf8')
  .split('<script>')[1].split('</script>')[0];
const elements = new Map();
const document = {getElementById(id) {
  if (!elements.has(id)) elements.set(id, {textContent: '', innerHTML: '', dataset: {},
    classList: {remove() {}}, addEventListener() {}});
  return elements.get(id);
}};
const pending = new Map();
const sandbox = {document, console, setTimeout, fetch: (path) => new Promise((resolve, reject) => {
  pending.set(path, {resolve: (data) => resolve({ok: true, json: async () => data}), reject});
})};
vm.createContext(sandbox);
vm.runInContext(page.slice(0, page.lastIndexOf('(async () => {')), sandbox);
vm.runInContext(`draw = () => {}; renderStats = () => {}; renderLegend = () => {};
renderSummary = () => {}; renderTrace = () => {};
issues = [{issue_date:'2026-01-31'}, {issue_date:'2026-02-01'}];`, sandbox);
const evaluate = (s) => vm.runInContext(s, sandbox);
const flush = () => new Promise((r) => setImmediate(r));
const row = {issue_time_utc:'2026-01-31T19:00:00Z', issue_time_local:'2026-02-01T00:00:00+05:00',
 target_time_utc:'2026-01-31T19:00:00Z', target_time_local:'2026-02-01T00:00:00+05:00',
 lead_h:0, horizon:'24h', revision:0, power_t1:0.4, power_t2:0.4, power_farm:0.4,
 p10:0.2, p90:0.6, ws100_fc:null, wx_field:'none', wx_model:'none', model_name:'climatology',
 fallback_used:true, run_id:'new'};
const issue = (id) => ({issue_date:id === 'old' ? '2026-01-31' : '2026-02-01',
 run_id:id, model_name:'climatology', rows:[{...row, run_id:id}], warnings:[], fallback_used:true});
const steps = [{status:'ok'}];
(async () => {
  // An old forecast response arrives after the new issue has finished.
  evaluate('idx=0; loadIssue()'); evaluate('idx=1; loadIssue()');
  pending.get('/api/forecast/2026-02-01').resolve(issue('new')); await flush();
  pending.get('/api/runs/new/log').resolve(steps); await flush();
  pending.get('/api/forecast/2026-01-31').resolve(issue('old')); await flush();
  assert.equal(evaluate('currentIssue.run_id'), 'new');
  assert.equal(elements.get('issue-status').dataset.state, 'fallback');
  // Old log response must also be ignored.
  evaluate('idx=0; loadIssue()');
  pending.get('/api/forecast/2026-01-31').resolve(issue('old')); await flush();
  evaluate('idx=1; loadIssue()');
  assert.equal(evaluate('currentIssue'), null);
  assert.equal(elements.get('export').disabled, true);
  pending.get('/api/forecast/2026-02-01').resolve(issue('new')); await flush();
  pending.get('/api/runs/new/log').resolve(steps); await flush();
  pending.get('/api/runs/old/log').resolve([{status:'fail'}]); await flush();
  assert.equal(evaluate('currentIssue.run_id'), 'new');
  // An old rejection must not clear the current successful issue.
  evaluate('idx=0; loadIssue()'); evaluate('idx=1; loadIssue()');
  pending.get('/api/forecast/2026-02-01').resolve(issue('new')); await flush();
  pending.get('/api/runs/new/log').resolve(steps); await flush();
  pending.get('/api/forecast/2026-01-31').reject(new Error('old failure')); await flush();
  assert.equal(evaluate('currentIssue.run_id'), 'new');
  // Missing log triggers review, not a false success.
  evaluate('idx=1; loadIssue()');
  pending.get('/api/forecast/2026-02-01').resolve(issue('new')); await flush();
  pending.get('/api/runs/new/log').reject(new Error('missing log')); await flush();
  assert.equal(elements.get('issue-status').dataset.state, 'review');
  sandbox.fixture = {...issue('new'), rows:[row, {...row, revision:1, wx_model:'=malicious()'}]};
  const csv = evaluate('csvForIssue(fixture)');
  assert.equal(csv.trim().split('\r\n').length, 3);
  assert.ok(csv.includes('"\'=malicious()"'));
  assert.ok(csv.includes('"0.6","","none"')); // Missing wind must not become zero.
  evaluate('idx=0; loadIssue()');
  pending.get('/api/forecast/2026-01-31').reject(new Error('current failure')); await flush();
  assert.equal(evaluate('currentIssue'), null);
  assert.equal(elements.get('export').disabled, true);
  assert.equal(elements.get('provenance').hidden, true);
})().catch((error) => {console.error(error); process.exitCode = 1;});
'''
    result = subprocess.run(
        [node, "-e", script], cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=30
    )
    assert result.returncode == 0, result.stderr

"""R9 tool-loop behavior, guardrails and keyless operation; no network calls."""

import json
from datetime import UTC, date, datetime, timedelta

import pytest

from app.agent import planner
from app.schemas import ForecastIssue, ForecastRow


@pytest.fixture
def issue():
    t0 = datetime(2026, 2, 1, tzinfo=UTC)
    rows = [ForecastRow(
        issue_time_utc=t0, issue_time_local=t0, target_time_utc=t0 + timedelta(hours=h),
        target_time_local=t0 + timedelta(hours=h), lead_h=h,
        horizon="24h" if h < 24 else "48h", revision=0,
        power_t1=0.4, power_t2=0.4, power_farm=0.4, p10=0.2, p90=0.6,
        ws100_fc=6, wx_field="day3", wx_model="best_match", model_name="gbm", run_id="test",
    ) for h in range(48)]
    return ForecastIssue(issue_date=date(2026, 1, 31), issue_time_utc=t0, run_id="test",
                         model_name="gbm", revision=0, fallback_used=False, rows=rows, summary="")


def _reply(*actions):
    return {"message": {"role": "assistant", "tool_calls": [
        {"id": f"call_{i}_{name}", "type": "function", "function": {
            "name": name, "arguments": json.dumps(args),
        }} for i, (name, args) in enumerate(actions)
    ]}, "provider": "mock", "model": "test-model", "tokens": 20}


def _sequence(*replies):
    items = iter(replies)
    return lambda *a, **k: next(items)


def test_tool_observations_drive_followup_and_guard_cannot_be_overridden(issue, tmp_path):
    issue.warnings = ["source drift"]
    before = issue.model_dump_json()
    calls = []

    def complete(messages, specs, **kwargs):
        calls.append(messages.copy())
        if len(calls) == 1:
            return _reply(("quality", {}), ("weather", {}))
        assert json.loads(messages[-2]["content"])["review_required"]
        return _reply(("finish", {"disposition": "accepted", "evidence": ["quality", "weather"]}))

    result = planner.supervise(issue, tmp_path, complete=complete)
    assert result["mode"] == "llm" and result["disposition"] == "review"
    assert [e["tool"] for e in result["trace"]] == ["quality", "weather", "finish"]
    assert issue.model_dump_json() == before
    assert json.loads((tmp_path / "supervisor.json").read_text())["disposition"] == "review"


@pytest.mark.parametrize("reply", [
    _reply(("shell", {"command": "anything"})),
    _reply(("quality", {"issue_date": "2026-02-10"})),
    _reply(("finish", {"disposition": "accepted", "evidence": ["quality", "weather"]})),
    {"message": {"content": "trust me"}, "provider": "mock", "model": "m", "tokens": 0},
    None,
])
def test_invalid_or_unavailable_model_falls_back_to_review(issue, tmp_path, reply):
    result = planner.supervise(issue, tmp_path, complete=_sequence(reply))
    assert result["disposition"] == "review" and result["mode"] == "demo"
    assert result["fallback_reason"]


def test_round_budget_and_provider_exception_preserve_forecast(issue, tmp_path):
    result = planner.supervise(issue, tmp_path, complete=lambda *a, **k: _reply(("quality", {})))
    assert len(result["trace"]) <= 4 and result["disposition"] == "review"

    def unavailable(*a, **k):
        raise TimeoutError("secret provider payload must never appear")

    result = planner.supervise(issue, tmp_path, complete=unavailable)
    assert result["fallback_reason"] == "TimeoutError"
    assert "secret" not in (tmp_path / "supervisor.json").read_text()


def test_no_key_is_deterministic_and_makes_no_request(issue, tmp_path, monkeypatch):
    monkeypatch.setattr(planner.llm, "llm_mode", lambda: "demo")
    result = planner.supervise(issue, tmp_path)
    assert result["mode"] == "demo" and result["disposition"] == "accepted"
    assert result["trace"] == []


def test_revisions_must_be_examined_before_finishing(issue, tmp_path):
    issue.rows.append(issue.rows[14].model_copy(update={"revision": 1}))
    result = planner.supervise(issue, tmp_path, complete=_sequence(
        _reply(("quality", {}), ("weather", {})),
        _reply(("finish", {"disposition": "accepted", "evidence": ["quality", "weather"]})),
    ))
    assert result["disposition"] == "review" and result["mode"] == "demo"

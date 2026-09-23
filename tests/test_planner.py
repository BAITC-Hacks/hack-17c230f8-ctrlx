"""R9 tool-loop behavior, guardrails and keyless operation; no network calls."""

import json
from datetime import UTC, date, datetime, timedelta

import pytest

from app.agent import planner
from app.schemas import ForecastIssue, ForecastRow


@pytest.fixture
def issue():
    t0 = datetime(2026, 2, 1, tzinfo=UTC)
    rows = [
        ForecastRow(
            issue_time_utc=t0,
            issue_time_local=t0,
            target_time_utc=t0 + timedelta(hours=h),
            target_time_local=t0 + timedelta(hours=h),
            lead_h=h,
            horizon="24h" if h < 24 else "48h",
            revision=0,
            power_t1=0.4,
            power_t2=0.4,
            power_farm=0.4,
            p10=0.2,
            p90=0.6,
            ws100_fc=6,
            wx_field="day3",
            wx_model="best_match",
            model_name="gbm",
            run_id="test",
        )
        for h in range(48)
    ]
    return ForecastIssue(
        issue_date=date(2026, 1, 31),
        issue_time_utc=t0,
        run_id="test",
        model_name="gbm",
        revision=0,
        fallback_used=False,
        rows=rows,
        summary="",
    )


def _reply(*actions):
    return {
        "message": {
            "role": "assistant",
            "tool_calls": [
                {
                    "id": f"call_{i}_{name}",
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": json.dumps(args),
                    },
                }
                for i, (name, args) in enumerate(actions)
            ],
        },
        "provider": "mock",
        "model": "test-model",
        "tokens": 20,
    }


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


@pytest.mark.parametrize(
    "reply",
    [
        _reply(("shell", {"command": "anything"})),
        _reply(("quality", {"issue_date": "2026-02-10"})),
        _reply(("finish", {"disposition": "accepted", "evidence": ["quality", "weather"]})),
        {"message": {"content": "trust me"}, "provider": "mock", "model": "m", "tokens": 0},
        None,
    ],
)
def test_invalid_or_unavailable_model_falls_back_to_review(issue, tmp_path, reply):
    result = planner.supervise(issue, tmp_path, complete=_sequence(reply))
    assert result["disposition"] == "review" and result["mode"] == "demo"
    assert result["fallback_reason"]


def test_round_budget_and_provider_exception_preserve_forecast(issue, tmp_path):
    rounds = []

    def never_finish(*args, **kwargs):
        reply = _reply(("quality", {}))
        reply["message"]["tool_calls"][0]["id"] = f"round_{len(rounds)}"
        rounds.append(reply)
        return reply

    result = planner.supervise(issue, tmp_path, complete=never_finish)
    assert len(rounds) == len(result["trace"]) == 4
    assert result["disposition"] == "review" and result["mode"] == "demo"

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
    result = planner.supervise(
        issue,
        tmp_path,
        complete=_sequence(
            _reply(("quality", {}), ("weather", {})),
            _reply(("finish", {"disposition": "accepted", "evidence": ["quality", "weather"]})),
        ),
    )
    assert result["disposition"] == "review" and result["mode"] == "demo"


def test_usage_counted_once_for_a_round_with_three_tool_calls(issue, tmp_path):
    issue.rows.append(issue.rows[14].model_copy(update={"revision": 1}))
    diagnostics = _reply(("quality", {}), ("weather", {}), ("revisions", {}))
    diagnostics.update(tokens=45, input_tokens=30, output_tokens=15)
    finish = _reply(
        (
            "finish",
            {
                "disposition": "accepted",
                "evidence": ["quality", "weather", "revisions"],
            },
        )
    )
    finish.update(tokens=20, input_tokens=12, output_tokens=8)
    result = planner.supervise(issue, tmp_path, complete=_sequence(diagnostics, finish))
    assert result["mode"] == "llm" and result["disposition"] == "accepted"
    assert len(result["trace"]) == 4
    assert result["usage"]["total_tokens"] == 65
    assert result["usage"]["input_tokens"] == 42
    assert result["usage"]["output_tokens"] == 23
    assert [entry["total_tokens"] for entry in result["usage"]["rounds"]] == [45, 20]


def test_finish_cannot_claim_to_have_seen_tools_in_the_same_reply(issue, tmp_path):
    reply = _reply(
        ("quality", {}),
        ("weather", {}),
        ("finish", {"disposition": "accepted", "evidence": ["quality", "weather"]}),
    )
    result = planner.supervise(issue, tmp_path, complete=_sequence(reply))
    assert result["mode"] == "demo" and result["disposition"] == "review"
    assert result["trace"] == []
    assert result["usage"]["total_tokens"] == 20


@pytest.mark.parametrize("same_round", [True, False])
def test_duplicate_tool_ids_cannot_be_used_as_new_observations(issue, tmp_path, same_round):
    quality, weather = _reply(("quality", {})), _reply(("weather", {}))
    weather["message"]["tool_calls"][0]["id"] = quality["message"]["tool_calls"][0]["id"]
    if same_round:
        quality["message"]["tool_calls"].extend(weather["message"]["tool_calls"])
        replies = [quality]
    else:
        replies = [quality, weather]
    result = planner.supervise(issue, tmp_path, complete=_sequence(*replies))
    assert result["mode"] == "demo" and result["disposition"] == "review"
    assert [entry["tool"] for entry in result["trace"]] == ["quality"]


@pytest.mark.parametrize(
    "failure", ["missing_hour", "duplicate_hour", "nan_initial", "nan_revision"]
)
@pytest.mark.parametrize("with_llm", [False, True])
def test_invalid_horizon_is_reviewable_and_serializes_without_nan(
    issue,
    tmp_path,
    monkeypatch,
    failure,
    with_llm,
):
    if failure == "missing_hour":
        issue.rows.pop()
    elif failure == "duplicate_hour":
        issue.rows.append(issue.rows[0].model_copy())
    elif failure == "nan_initial":
        issue.rows[0] = issue.rows[0].model_copy(update={"power_t1": float("nan")})
    else:
        issue.rows.append(
            issue.rows[14].model_copy(
                update={"revision": 1, "power_farm": float("nan")},
            )
        )
    if with_llm:
        names = ["quality", "weather"] + (["revisions"] if failure == "nan_revision" else [])
        complete = _sequence(
            _reply(*((name, {}) for name in names)),
            _reply(("finish", {"disposition": "accepted", "evidence": names})),
        )
        result = planner.supervise(issue, tmp_path, complete=complete)
        assert result["mode"] == "llm"
    else:
        monkeypatch.setattr(planner.llm, "llm_mode", lambda: "demo")
        result = planner.supervise(issue, tmp_path)
        assert result["mode"] == "demo"
    assert result["disposition"] == "review"
    payload = (tmp_path / "supervisor.json").read_text()
    assert "NaN" not in payload and "Infinity" not in payload
    assert json.loads(payload)["disposition"] == "review"
    assert list(tmp_path.glob("*.tmp")) == []

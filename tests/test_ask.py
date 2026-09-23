"""R9: ask-the-agent answers come from run facts; LLM text passes only if every number is a fact."""

import pytest
from pydantic import ValidationError

from app import ask, config
from app.schemas import AskRequest


def _committed_run() -> str:
    """A run with both a log and forecast rows (after a retrain, stale runs may lack the CSV)."""
    for path in sorted(config.RUNS_DIR.iterdir()):
        facts = ask.load_facts(path.name)
        if facts.steps and not facts.rows.empty:
            return path.name
    pytest.skip("no committed run with a log and forecast rows")


@pytest.fixture(scope="module")
def run_id() -> str:
    return _committed_run()


@pytest.fixture(autouse=True)
def demo_mode(monkeypatch):
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "demo")


@pytest.mark.parametrize(
    "question",
    [
        "Какой пик выработки?",
        "Откуда погода и нет ли утечки будущего?",
        "Что изменилось после пересчёта?",
        "Сколько энергии за сутки и какой коридор?",
        "Что делал агент?",
        "Что будет в 12:00?",
    ],
)
def test_template_answers_are_grounded_in_the_facts(run_id, question):
    result = ask.answer(run_id, question)
    facts = ask.load_facts(run_id)
    assert result.mode == "demo" and result.grounded and result.sources
    assert ask.is_grounded(result.answer, facts) == (True, None)
    assert ask.numbers_in(result.answer), "a dispatcher answer quotes numbers"


def test_unknown_run_is_reported_not_raised():
    result = ask.answer("19990101T0000-nope", "Какой пик?")
    assert result.mode == "demo" and "не найден" in result.answer and result.sources == []


def test_grounding_rejects_numbers_that_are_not_facts(run_id):
    facts = ask.load_facts(run_id)
    ok, why = ask.is_grounded("Прогноз на завтра 99.97 % номинала", facts)
    assert not ok and why.startswith("ungrounded number")
    assert ask.is_grounded("Прогноз без чисел", facts) == (True, None)


def test_llm_answer_with_invented_number_falls_back_to_template(monkeypatch, run_id):
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(
        ask.llm,
        "complete_json",
        lambda *a, **k: ask._LlmReply(answer="Завтра будет 123456 МВт·ч.", sources=["report.md"]),
    )
    result = ask.answer(run_id, "Сколько энергии завтра?")
    assert result.mode == "demo" and result.grounded
    assert result.fallback_reason.startswith("ungrounded number")


def test_llm_answer_with_fact_numbers_is_accepted(monkeypatch, run_id):
    facts = ask.load_facts(run_id)
    peak = facts.derived["peak"]
    text = f"Пик {peak['pct']} номинала ожидается {peak['when']}."
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(
        ask.llm,
        "complete_json",
        lambda *a, **k: ask._LlmReply(answer=text, sources=["log#5 run_model"]),
    )
    result = ask.answer(run_id, "Какой пик?")
    assert result.mode == "llm" and result.grounded and result.answer == text
    assert "log#5 run_model" in result.sources


def test_llm_sources_are_checked_against_the_facts(monkeypatch, run_id):
    facts = ask.load_facts(run_id)
    text = f"Пик {facts.derived['peak']['pct']} номинала."
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(
        ask.llm,
        "complete_json",
        lambda *a, **k: ask._LlmReply(
            answer=text, sources=["log#5 run_model", "wikipedia", "log#99 oracle"]
        ),
    )
    result = ask.answer(run_id, "Какой пик?")
    assert result.mode == "llm"
    assert "log#5 run_model" in result.sources
    assert "wikipedia" not in result.sources and "log#99 oracle" not in result.sources


def test_llm_failure_falls_back_to_template(monkeypatch, run_id):
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(ask.llm, "complete_json", lambda *a, **k: None)
    result = ask.answer(run_id, "Какой пик?")
    assert result.mode == "demo" and result.fallback_reason == "llm unavailable"
    monkeypatch.setattr(ask.llm, "complete_json", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    assert ask.answer(run_id, "Какой пик?").fallback_reason == "llm unavailable"


def test_run_id_cannot_escape_the_runs_directory():
    for bad in ("../../pyproject.toml", "..\\..\\x", "runs/../x", "/etc/passwd", ""):
        result = ask.answer(bad, "Какой пик?")
        assert "не найден" in result.answer and result.sources == []


def test_number_extraction_handles_digit_groups_and_formats():
    assert ask.numbers_in("1 000 МВт·ч, 24 %, 0,24, 6.30 м/с, 13:00") == {
        "1000",
        "24",
        "0.24",
        "6.3",
        "13",
        "0",
    }


def test_llm_markup_is_stripped_before_grounding(monkeypatch, run_id):
    facts = ask.load_facts(run_id)
    pct = facts.derived["peak"]["pct"]
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(
        ask.llm,
        "complete_json",
        lambda *a, **k: ask._LlmReply(answer=f"<b>Пик {pct}</b><script>x()</script>", sources=[]),
    )
    result = ask.answer(run_id, "Какой пик?")
    assert result.mode == "llm" and "<" not in result.answer and pct in result.answer


def test_run_with_log_but_no_rows_is_answered_from_the_log_only(monkeypatch, tmp_path):
    from datetime import UTC, datetime

    from app.agent.log import RunLog

    monkeypatch.setattr(config, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(config, "OUTPUTS_FORECASTS", tmp_path)  # no issue csv at all
    log = RunLog("20260301T0000-stale", datetime(2026, 2, 28, 19, tzinfo=UTC), base_dir=tmp_path)
    log.step("plan", "ok", "Выпуск за 28 февраля", decision="facts_complete", reason="факт есть")
    result = ask.answer("20260301T0000-stale", "Какой пик?")
    assert result.mode == "demo" and "строк прогноза нет" in result.answer
    assert (
        result.grounded and ask.is_grounded(result.answer, ask.load_facts("20260301T0000-stale"))[0]
    )


def test_template_grounded_flag_is_computed_not_assumed(monkeypatch, run_id):
    facts = ask.load_facts(run_id)
    monkeypatch.setattr(
        ask, "answer_template", lambda f, q: ("Пик 99.97 % номинала.", ["report.md"])
    )
    result = ask.answer(run_id, "Какой пик?")
    assert result.mode == "demo" and result.grounded is False
    assert result.fallback_reason.startswith("ungrounded number")
    assert ask.is_grounded("Пик 99.97 %", facts)[0] is False


def test_request_contract_rejects_one_letter_questions():
    with pytest.raises(ValidationError):
        AskRequest(run_id="x", question="a")


def test_stale_run_never_uses_old_report_or_calls_llm(monkeypatch, tmp_path):
    from datetime import UTC, datetime

    from app.agent.log import RunLog

    run_id = "20260301T0000-stale"
    monkeypatch.setattr(config, "RUNS_DIR", tmp_path)
    monkeypatch.setattr(config, "OUTPUTS_FORECASTS", tmp_path)
    log = RunLog(run_id, datetime(2026, 2, 28, 19, tzinfo=UTC), base_dir=tmp_path)
    log.step("run_model", "ok", "Старый прогноз: пик 99.97 %.")
    (log.dir / "report.md").write_text("Старый прогноз: пик 99.97 %.", encoding="utf-8")
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(
        ask.llm,
        "complete_json",
        lambda *a, **k: pytest.fail("LLM must not infer a missing forecast from stale logs"),
    )
    facts = ask.load_facts(run_id)
    assert facts.rows.empty and facts.derived == {}
    result = ask.answer(run_id, "Какой пик?")
    assert "строк прогноза нет" in result.answer and "99.97" not in result.answer
    assert result.mode == "demo" and result.fallback_reason == "forecast rows unavailable"
    assert result.sources == [] and ask.is_grounded(result.answer, facts) == (True, None)


@pytest.mark.parametrize("source", ["invented.csv", "log#999 invented_tool"])
def test_llm_cannot_answer_with_only_invented_sources(monkeypatch, run_id, source):
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(
        ask.llm,
        "complete_json",
        lambda *a, **k: ask._LlmReply(answer="Прогноз готов.", sources=[source]),
    )
    result = ask.answer(run_id, "Какой пик?")
    assert result.mode == "demo" and result.fallback_reason == "unsupported llm sources"


def test_missing_report_or_revision_cannot_be_cited(run_id):
    facts = ask.load_facts(run_id)
    facts.report = ""
    facts.rows = facts.rows[facts.rows["revision"] == 0]
    known = ask.allowed_sources(facts)
    assert "report.md" not in known
    assert f"{facts.csv_name} rev1" not in known


def test_weather_answer_does_not_claim_verified_publication(run_id):
    text = ask.answer(run_id, "Откуда погода?").answer
    assert "Фактическое время публикации" in text


def test_megawatt_answers_disclose_scenario_capacity(run_id):
    result = ask.answer(run_id, "Сколько энергии за сутки?")
    assert "сценарном номинале" in result.answer
    assert "паспортная мощность" in result.answer
    assert result.grounded

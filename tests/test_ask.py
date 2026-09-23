"""R9: ask-the-agent answers come from run facts; LLM text passes only if every number is a fact."""

import pytest
from pydantic import ValidationError

from app import ask, config
from app.schemas import AskRequest


def _committed_run() -> str:
    for path in sorted(config.RUNS_DIR.iterdir()):
        if (path / "agent_log.jsonl").exists() and not ask.load_facts(path.name).empty:
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


def test_llm_failure_falls_back_to_template(monkeypatch, run_id):
    monkeypatch.setattr(ask.llm, "llm_mode", lambda: "llm")
    monkeypatch.setattr(ask.llm, "complete_json", lambda *a, **k: None)
    result = ask.answer(run_id, "Какой пик?")
    assert result.mode == "demo" and result.fallback_reason == "llm unavailable"
    monkeypatch.setattr(ask.llm, "complete_json", lambda *a, **k: (_ for _ in ()).throw(OSError()))
    assert ask.answer(run_id, "Какой пик?").fallback_reason == "llm unavailable"


def test_request_contract_rejects_one_letter_questions():
    with pytest.raises(ValidationError):
        AskRequest(run_id="x", question="a")

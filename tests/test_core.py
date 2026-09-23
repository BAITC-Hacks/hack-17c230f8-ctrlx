from app.core import STUB_LABEL, analyze_rule_based
from app.schemas import AnalyzeInput


def test_result_is_valid():
    result = analyze_rule_based(AnalyzeInput(text="Пример текста для проверки каркаса"))
    assert result.mode == "demo"
    assert result.fallback_reason is None
    assert result.label == STUB_LABEL
    assert 0 <= result.score <= 1
    assert all(isinstance(r, str) for r in result.reasons)


def test_is_deterministic():
    inp = AnalyzeInput(text="Второй пример текста")
    assert analyze_rule_based(inp) == analyze_rule_based(inp)


def test_reports_basic_text_statistics():
    result = analyze_rule_based(AnalyzeInput(text="  три слова здесь  "))
    assert result.reasons == ["символов: 15", "слов: 3"]

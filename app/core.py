"""Skeleton stub, domain-free on purpose: the task's own rules replace it right after kickoff,
so nothing task-like exists before the competition starts."""

from app.schemas import AnalyzeInput, AnalyzeResult

STUB_LABEL = "заглушка"


def analyze_rule_based(inp: AnalyzeInput) -> AnalyzeResult:
    text = inp.text.strip()
    return AnalyzeResult(
        label=STUB_LABEL,
        score=0.0,
        summary="Каркас: логика задачи появится после разбора ТЗ.",
        reasons=[f"символов: {len(text)}", f"слов: {len(text.split())}"],
        mode="demo",
    )

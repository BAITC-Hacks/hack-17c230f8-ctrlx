"""Analysis orchestration: try the LLM, fall back to rule-based analysis."""

from pydantic import BaseModel, Field

from app.core import analyze_rule_based
from app.llm import complete_json, llm_mode
from app.pii import mask_pii
from app.schemas import AnalyzeInput, AnalyzeResult

SYSTEM_PROMPT = (
    "Ты - ассистент, который анализирует текст пользователя и возвращает "
    "строго JSON-объект без пояснений и markdown со следующими полями: "
    '"label" (строка - краткая категория текста), '
    '"score" (число от 0 до 1 - уверенность в категории), '
    '"summary" (одно-два предложения на русском языке с кратким резюме), '
    '"reasons" (список строк - краткие причины, на которых основана оценка).'
)


class _LlmAnalysis(BaseModel):
    """AnalyzeResult content fields, minus the mode/fallback_reason bookkeeping."""

    label: str
    score: float = Field(ge=0, le=1)
    summary: str
    reasons: list[str]


def analyze(inp: AnalyzeInput) -> AnalyzeResult:
    if llm_mode() == "demo":
        return analyze_rule_based(inp)

    # Kazakhstan personal-data law: PII must never reach an external LLM.
    masked_text, found = mask_pii(inp.text)
    masked_count = sum(found.values())

    llm_result = complete_json(_LlmAnalysis, SYSTEM_PROMPT, masked_text)
    if llm_result is None:
        fallback = analyze_rule_based(inp)
        return fallback.model_copy(update={"fallback_reason": "llm_failed"})

    return AnalyzeResult(
        label=llm_result.label,
        score=llm_result.score,
        summary=llm_result.summary,
        reasons=llm_result.reasons,
        mode="llm",
        masked_pii=masked_count,
    )

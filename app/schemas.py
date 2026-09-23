from typing import Literal

from pydantic import BaseModel, Field


class AnalyzeInput(BaseModel):
    text: str = Field(min_length=1, max_length=20000)


class AnalyzeResult(BaseModel):
    label: str
    score: float = Field(ge=0, le=1)
    summary: str
    reasons: list[str]
    mode: Literal["llm", "demo"]
    fallback_reason: str | None = None
    masked_pii: int = 0

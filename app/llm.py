"""LLM client: OpenAI-compatible chat.completions with a JSON-object response.

Uses chat.completions (not the Responses API) so OpenAI-compatible endpoints
such as NVIDIA's (https://integrate.api.nvidia.com/v1) work too.
"""

import json
import logging
import os
from pathlib import Path
from typing import Literal

from dotenv import load_dotenv
from openai import OpenAI
from pydantic import BaseModel

logger = logging.getLogger(__name__)

# app/llm.py -> app/ -> project root
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
# .env.local wins on conflicts since it loads first and override=False keeps
# already-set values.
load_dotenv(_PROJECT_ROOT / ".env.local", override=False)
load_dotenv(_PROJECT_ROOT / ".env", override=False)

DEFAULT_BASE_URL = "https://api.openai.com/v1"


def _demo_forced() -> bool:
    return os.getenv("DEMO_MODE", "auto").strip().lower() in {"1", "true"}


def llm_mode() -> Literal["llm", "demo"]:
    if _demo_forced():
        return "demo"
    if os.getenv("LLM_API_KEY") and os.getenv("LLM_MODEL"):
        return "llm"
    return "demo"


def complete_json[ModelT: BaseModel](
    model_cls: type[ModelT], system: str, user: str
) -> ModelT | None:
    """Call the LLM and validate its JSON reply against model_cls, or return None."""
    api_key = os.getenv("LLM_API_KEY")
    model = os.getenv("LLM_MODEL")
    if not api_key or not model:
        logger.warning("complete_json: missing LLM_API_KEY or LLM_MODEL")
        return None

    base_url = os.getenv("LLM_BASE_URL", DEFAULT_BASE_URL)
    client = OpenAI(api_key=api_key, base_url=base_url, timeout=20, max_retries=1)

    try:
        response = client.chat.completions.create(
            model=model,
            messages=[
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            response_format={"type": "json_object"},
        )
        content = response.choices[0].message.content
        if not content:
            raise ValueError("empty completion content")
        data = json.loads(content)
        return model_cls.model_validate(data)
    except Exception as exc:  # any failure -> caller falls back to rule-based
        logger.warning("complete_json failed: %s", type(exc).__name__)
        return None

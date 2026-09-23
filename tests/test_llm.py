"""R9: provider failures and provenance isolation; never calls an external API."""

from contextvars import copy_context
from types import SimpleNamespace

from pydantic import BaseModel

from app import llm


class Reply(BaseModel):
    answer: str


def test_complete_json_bounds_calls_and_clears_stale_provenance(monkeypatch):
    calls, options = [], []

    class Client:
        def __init__(self, **kwargs):
            options.append(kwargs)
            self.chat = SimpleNamespace(completions=self)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def create(self, **kwargs):
            calls.append(kwargs)
            if "response_format" in kwargs:
                raise ValueError("format unsupported")
            return SimpleNamespace(
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"answer":"ok"}'))],
                usage=SimpleNamespace(total_tokens=8),
            )

    monkeypatch.setattr(llm, "OpenAI", Client)
    monkeypatch.setattr(llm, "_demo_forced", lambda: False)
    monkeypatch.setattr(llm, "_providers", lambda: [("test-only", "mock", "model")])
    result = llm.complete_json(Reply, "system", "user")
    assert result.answer == "ok" and len(calls) == 2
    assert all(o["max_retries"] == 0 and o["timeout"] <= 8 for o in options)
    assert all(c["max_tokens"] == 1000 for c in calls)
    assert llm.last_provider()["tokens"] == 8
    monkeypatch.setattr(llm, "_demo_forced", lambda: True)
    assert llm.complete_json(Reply, "system", "user") is None
    assert llm.last_provider() == {}


def test_provider_metadata_is_local_to_execution_context():
    llm._LAST.set({"model": "outer"})
    other = copy_context()
    other.run(llm._LAST.set, {"model": "inner"})
    assert llm.last_provider() == {"model": "outer"}
    assert other.run(llm.last_provider) == {"model": "inner"}
    llm._LAST.set({})

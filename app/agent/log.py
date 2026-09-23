"""JSONL agent log: one AgentStep per line in runs/<run_id>/agent_log.jsonl."""

import json
import time
from datetime import UTC, datetime
from pathlib import Path

from app.config import RUNS_DIR
from app.schemas import AgentStep, LlmInfo


class RunLog:
    def __init__(self, run_id: str, issue_time: datetime, base_dir: Path = RUNS_DIR):
        self.run_id = run_id
        self.issue_time = issue_time
        self.dir = base_dir / run_id
        self.dir.mkdir(parents=True, exist_ok=True)
        self.path = self.dir / "agent_log.jsonl"
        self.steps: list[AgentStep] = []

    def step(
        self,
        tool: str,
        status: str,
        summary: str,
        *,
        args: dict | None = None,
        decision: str | None = None,
        reason: str | None = None,
        started: float | None = None,
        llm: LlmInfo | None = None,
    ) -> AgentStep:
        entry = AgentStep(
            ts=datetime.now(UTC),
            run_id=self.run_id,
            issue_time=self.issue_time,
            step=len(self.steps) + 1,
            tool=tool,
            args=args or {},
            status=status,  # type: ignore[arg-type]
            summary=summary,
            decision=decision,
            reason=reason,
            duration_ms=int((time.perf_counter() - started) * 1000) if started else 0,
            llm=llm,
        )
        self.steps.append(entry)
        with self.path.open("a", encoding="utf-8", newline="\n") as f:
            f.write(json.dumps(entry.model_dump(mode="json"), ensure_ascii=False) + "\n")
        return entry

    @staticmethod
    def read(run_id: str, base_dir: Path = RUNS_DIR) -> list[AgentStep]:
        path = base_dir / run_id / "agent_log.jsonl"
        if not path.exists():
            return []
        with path.open(encoding="utf-8") as f:
            return [AgentStep.model_validate_json(line) for line in f if line.strip()]

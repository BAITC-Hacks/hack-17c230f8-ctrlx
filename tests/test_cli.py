import json
import subprocess
import sys
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SAMPLE_PATH = PROJECT_ROOT / "data" / "sample.json"


def test_cli_runs_on_sample_data():
    result = subprocess.run(
        [sys.executable, "-m", "app.cli", str(SAMPLE_PATH)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr

    payload = json.loads(result.stdout)
    sample_count = len(json.loads(SAMPLE_PATH.read_text(encoding="utf-8")))
    assert isinstance(payload, list)
    assert len(payload) == sample_count
    for item in payload:
        assert item["mode"] in ("llm", "demo")
        assert 0 <= item["score"] <= 1


def test_cli_reports_error_on_invalid_json():
    result = subprocess.run(
        [sys.executable, "-m", "app.cli", "-"],
        cwd=PROJECT_ROOT,
        input="not json",
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 2
    assert result.stderr.strip() != ""

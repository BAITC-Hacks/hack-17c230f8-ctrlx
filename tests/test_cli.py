import subprocess
import sys
from pathlib import Path

from app.config import safe_previous_day

PROJECT_ROOT = Path(__file__).resolve().parent.parent


def test_cli_help_runs():
    result = subprocess.run(
        [sys.executable, "-m", "app.cli", "--help"],
        cwd=PROJECT_ROOT,
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    assert "backtest" in result.stdout


def test_leakage_rule_is_conservative():
    # publish delay 7 h; at t0: lead 0..16 -> day1, 17..40 -> day2, 41..47 -> day3
    assert safe_previous_day(0) == 1
    assert safe_previous_day(16) == 1
    assert safe_previous_day(17) == 2
    assert safe_previous_day(40) == 2
    assert safe_previous_day(41) == 3
    assert safe_previous_day(47) == 3
    # intraday refresh at t0 + 12 h: fresher runs become safe
    assert safe_previous_day(28, hours_since_issue=12) == 1
    assert safe_previous_day(29, hours_since_issue=12) == 2
    assert safe_previous_day(47, hours_since_issue=12) == 2

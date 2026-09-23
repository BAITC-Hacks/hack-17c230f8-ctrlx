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


def test_complete_february_artifacts():
    """R6: checks both shipped results and fresh train/backtest outputs in smoke."""
    import csv
    import math
    from datetime import UTC, datetime, timedelta

    from app.schemas import ForecastRow

    folder = PROJECT_ROOT / "outputs" / "forecasts"
    expected = [datetime(2026, 1, 31) + timedelta(days=i) for i in range(28)]
    files = sorted(folder.glob("issue_*.csv"))
    assert {p.stem for p in files} == {f"issue_{d.date()}" for d in expected}
    for file in files:
        with file.open(encoding="utf-8", newline="") as stream:
            rows = [ForecastRow.model_validate(r) for r in csv.DictReader(stream)]
        rev0 = [r for r in rows if r.revision == 0]
        assert sorted(r.lead_h for r in rev0) == list(range(48)), file.name
        assert len({(r.revision, r.target_time_utc) for r in rows}) == len(rows)
        assert len({r.run_id for r in rows}) == 1
        for r in rows:
            assert r.target_time_utc == r.issue_time_utc + timedelta(hours=r.lead_h)
            assert r.p10 <= r.power_farm <= r.p90, (file.name, r.lead_h)
            assert r.target_time_local == r.target_time_utc
        run = PROJECT_ROOT / "runs" / rows[0].run_id
        assert (run / "agent_log.jsonl").stat().st_size > 0
        assert (run / "report.md").stat().st_size > 0

    with (folder / "february_2026.csv").open(encoding="utf-8", newline="") as stream:
        month = list(csv.DictReader(stream))
    start = datetime(2026, 1, 31, 19, tzinfo=UTC)
    assert [datetime.fromisoformat(r["target_time_utc"]) for r in month] == [
        start + timedelta(hours=i) for i in range(672)
    ]
    for i, r in enumerate(month):
        for column in ("power_farm_plan", "power_t1_plan", "power_t2_plan", "p10_plan", "p90_plan"):
            value = float(r[column])
            assert math.isfinite(value) and 0 <= value <= 1, (i, column)
        assert float(r["p10_plan"]) <= float(r["power_farm_plan"]) <= float(r["p90_plan"])
        # The first day's day-ahead issue predates the supplied issue range.
        if i < 24:
            assert not r["power_farm_bid"]
        else:
            assert 0 <= float(r["power_farm_bid"]) <= 1

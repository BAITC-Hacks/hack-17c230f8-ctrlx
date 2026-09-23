"""R4/R6: partial or failed backtests cannot destroy the complete February artifact."""

from datetime import date, timedelta

import pandas as pd
import pytest

from app import service
from app.features import issue_time_utc
from app.schemas import ForecastIssue, ForecastRow


def _issue(day):
    t0 = issue_time_utc(day).to_pydatetime()
    run_id = f"run-{day}"
    rows = [
        ForecastRow(
            issue_time_utc=t0,
            issue_time_local=t0,
            target_time_utc=t0 + timedelta(hours=lead),
            target_time_local=t0 + timedelta(hours=lead),
            lead_h=lead,
            horizon="24h" if lead < 24 else "48h",
            revision=0,
            power_t1=0.4,
            power_t2=0.4,
            power_farm=0.4,
            p10=0.2,
            p90=0.6,
            ws100_fc=6.0,
            wx_field="day3",
            wx_model="best_match",
            model_name="gbm",
            run_id=run_id,
        )
        for lead in range(48)
    ]
    return ForecastIssue(
        issue_date=day,
        issue_time_utc=t0,
        run_id=run_id,
        model_name="gbm",
        revision=0,
        fallback_used=False,
        rows=rows,
        summary="",
    )


@pytest.fixture
def artifacts(tmp_path, monkeypatch):
    canonical = tmp_path / "february_2026.csv"
    canonical.write_bytes(b"previous complete artifact\n")
    monkeypatch.setattr(service, "OUTPUTS_FORECASTS", tmp_path)
    monkeypatch.setattr(service, "FEBRUARY_PATH", canonical)
    return canonical


def test_reversed_bounds_fail_before_any_forecast(artifacts, monkeypatch):
    calls = []
    monkeypatch.setattr(service, "forecast", lambda day, **kw: calls.append(day))
    with pytest.raises(ValueError, match="Начало периода"):
        service.backtest(date(2026, 2, 11), date(2026, 2, 10))
    assert calls == []
    assert artifacts.read_bytes() == b"previous complete artifact\n"


@pytest.mark.parametrize(
    "start,end",
    [
        (date(2026, 2, 10), date(2026, 2, 10)),
        (date(2026, 3, 1), date(2026, 3, 2)),
    ],
)
def test_partial_ranges_publish_separate_file_without_touching_canonical(
    artifacts,
    monkeypatch,
    start,
    end,
):
    monkeypatch.setattr(service, "forecast", lambda day, **kw: _issue(day))
    issues = service.backtest(start, end)
    path = service.aggregate_path(start, end)
    assert path.name == f"range_{start}_{end}.csv"
    aggregate = pd.read_csv(path)
    assert len(aggregate) == len(issues) * 24
    assert aggregate["power_farm_plan"].notna().all()
    assert artifacts.read_bytes() == b"previous complete artifact\n"


def test_full_period_publishes_672_hours(artifacts, monkeypatch):
    monkeypatch.setattr(service, "forecast", lambda day, **kw: _issue(day))
    issues = service.backtest()
    aggregate = pd.read_csv(artifacts)
    assert len(issues) == 28 and len(aggregate) == 672
    assert aggregate["target_time_utc"].is_unique
    assert aggregate["power_farm_plan"].notna().all()
    # The first observation-day issue has no prior issue from which to make the first bid.
    assert aggregate["power_farm_bid"].isna().sum() == 24


@pytest.mark.parametrize("bad_set", ["empty", "partial", "duplicate", "missing_hour", "nan"])
def test_invalid_aggregation_preserves_existing_canonical(artifacts, bad_set):
    issues = [_issue(service.TEST_ISSUE_FIRST + timedelta(days=i)) for i in range(28)]
    if bad_set == "empty":
        issues = []
    elif bad_set == "partial":
        issues.pop()
    elif bad_set == "duplicate":
        issues[1] = issues[0]
    elif bad_set == "missing_hour":
        issues[0].rows.pop()
    else:
        issues[0].rows[0] = issues[0].rows[0].model_copy(update={"power_t1": float("nan")})
    with pytest.raises(ValueError):
        service.write_february(issues)
    assert artifacts.read_bytes() == b"previous complete artifact\n"


def test_serialization_error_does_not_truncate_canonical(artifacts, monkeypatch):
    issues = [_issue(service.TEST_ISSUE_FIRST + timedelta(days=i)) for i in range(28)]

    def fail_after_partial_write(self, stream, **kwargs):
        stream.write("incomplete")
        raise OSError("disk write failed")

    monkeypatch.setattr(pd.DataFrame, "to_csv", fail_after_partial_write)
    with pytest.raises(OSError, match="disk write failed"):
        service.write_february(issues)
    assert artifacts.read_bytes() == b"previous complete artifact\n"
    assert not list(artifacts.parent.glob(".aggregate-*"))


def test_forecast_failure_does_not_replace_canonical(artifacts, monkeypatch):
    def fail(day, **kwargs):
        if day == service.TEST_ISSUE_FIRST + timedelta(days=1):
            raise ValueError("model rejected")
        return _issue(day)

    monkeypatch.setattr(service, "forecast", fail)
    with pytest.raises(ValueError, match="model rejected"):
        service.backtest()
    assert artifacts.read_bytes() == b"previous complete artifact\n"

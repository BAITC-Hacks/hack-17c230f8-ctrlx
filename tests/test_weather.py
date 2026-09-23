"""R2: weather cache, offline load, leak-safe selection per issue."""

import json

import pandas as pd
import pytest

from app import config, weather
from app.schemas import ISSUE_WEATHER_COLUMNS, WEATHER_COLUMNS

T0_FIRST = pd.Timestamp("2026-02-01 00:00", tz=config.LOCAL_TZ).tz_convert("UTC")
T0_LAST = pd.Timestamp("2026-02-28 00:00", tz=config.LOCAL_TZ).tz_convert("UTC")


@pytest.fixture(scope="module")
def wx():
    return weather.load_or_fetch("best_match")


def test_local_time_is_utc_plus_5_after_march_2024():
    assert T0_FIRST == pd.Timestamp("2026-01-31 19:00", tz="UTC")


@pytest.mark.parametrize("model", config.WEATHER_MODELS)
def test_cache_is_committed_and_covers_test_period(model):
    df = weather.load_or_fetch(model)
    assert list(df.columns) == WEATHER_COLUMNS
    assert df["time_utc"].max() >= T0_LAST + pd.Timedelta(hours=config.HORIZON_H - 1)
    meta = json.loads((config.WEATHER_CACHE / "meta.json").read_text(encoding="utf-8"))
    assert len(meta["models"][model]["sha256"]) == 64


def test_offline_load_does_not_fetch(monkeypatch, wx):
    def no_network(*a, **k):
        raise OSError("offline")

    monkeypatch.setattr(weather.urllib.request, "urlopen", no_network)
    df = weather.load_or_fetch("best_match", refresh=True)  # fetch fails -> cache
    assert len(df) == len(wx)


def test_offline_without_cache_returns_empty_frame(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WEATHER_CACHE", tmp_path)
    monkeypatch.setattr(
        weather.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError())
    )
    df = weather.load_or_fetch("best_match")
    assert df.empty and list(df.columns) == WEATHER_COLUMNS


@pytest.mark.parametrize("hours_since_issue", [0, config.INTRADAY_REFRESH_H])
def test_selected_field_is_never_fresher_than_allowed(wx, hours_since_issue):
    sel = weather.select_for_issue(wx, T0_FIRST, hours_since_issue)
    for lead, field in zip(sel["lead_h"], sel["wx_field"], strict=True):
        assert int(field.removeprefix("day")) >= config.safe_previous_day(lead, hours_since_issue)


@pytest.mark.parametrize("t0", [T0_FIRST, T0_LAST])
def test_48_rows_without_nan_from_cache(wx, t0):
    sel = weather.select_for_issue(wx, t0)
    assert list(sel.columns) == ISSUE_WEATHER_COLUMNS
    assert len(sel) == config.HORIZON_H
    assert sel["target_time_utc"].iloc[0] == t0
    assert not sel.isna().any().any()


def test_missing_value_falls_back_to_older_run_only():
    times = pd.date_range(T0_FIRST, periods=config.HORIZON_H, freq="h")
    wx = pd.DataFrame({"time_utc": times, **{c: 5.0 for c in WEATHER_COLUMNS[1:]}})
    wx.loc[0, "ws100_d1"] = float("nan")  # lead 0: day1 missing -> day2, not something fresher
    wx.loc[0, "ws100_d2"] = 7.0
    sel = weather.select_for_issue(wx, T0_FIRST, model="test")
    assert sel.loc[0, "wx_field"] == "day2" and sel.loc[0, "ws100"] == 7.0
    assert (sel["wx_model"] == "test").all()


def test_day2_only_fields_are_not_taken_where_day2_is_unsafe():
    times = pd.date_range(T0_FIRST, periods=config.HORIZON_H, freq="h")
    wx = pd.DataFrame({"time_utc": times, **{c: 5.0 for c in WEATHER_COLUMNS[1:]}})
    wx["temp2m_d2"] = range(config.HORIZON_H)
    sel = weather.select_for_issue(wx, T0_FIRST)
    last_safe = max(lead for lead in range(config.HORIZON_H) if config.safe_previous_day(lead) <= 2)
    assert (sel.loc[sel["lead_h"] > last_safe, "temp2m"] == last_safe).all()

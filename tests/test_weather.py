"""R2: weather cache, offline load, leak-safe selection per issue."""

import json

import numpy as np
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


def test_offline_without_cache_raises_a_clear_error(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WEATHER_CACHE", tmp_path)
    monkeypatch.setattr(
        weather.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError())
    )
    with pytest.raises(FileNotFoundError, match="refresh=True"):
        weather.load_or_fetch("best_match")


def test_corrupted_cache_raises_a_clear_error(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "WEATHER_CACHE", tmp_path)
    weather.cache_path("best_match").write_text("{not json", encoding="utf-8")
    with pytest.raises(ValueError, match="unreadable"):
        weather.load_or_fetch("best_match")


def test_load_marks_its_source(wx):
    assert wx.attrs["source"] == "cache" and wx.attrs["model"] == "best_match"


def test_issue_outside_cache_window_raises(wx):
    with pytest.raises(ValueError, match="outside"):
        weather.select_for_issue(wx, pd.Timestamp("2023-06-01", tz="UTC"))


def _synthetic(t0: pd.Timestamp) -> pd.DataFrame:
    """Every value encodes its run and lead: ws100_dN = 100N + lead, ws10_dN = 10N + lead."""
    lead = np.arange(config.HORIZON_H)
    wx = pd.DataFrame({"time_utc": pd.date_range(t0, periods=config.HORIZON_H, freq="h")})
    for n in (1, 2, 3):
        wx[f"ws100_d{n}"] = 100 * n + lead
        wx[f"ws10_d{n}"] = 10 * n + lead
    wx["dir100_d2"], wx["temp2m_d2"], wx["gust10_d2"] = 200 + lead, 20 + lead, 2 + lead
    return wx[WEATHER_COLUMNS]


@pytest.mark.parametrize("hours_since_issue", [0, config.INTRADAY_REFRESH_H])
@pytest.mark.parametrize("day", range(28))
def test_values_come_from_the_safe_run_only(day, hours_since_issue):
    """Value-level leak test: not just the day1/2/3 label, the numbers must come from that run."""
    t0 = T0_FIRST + pd.Timedelta(days=day)
    sel = weather.select_for_issue(_synthetic(t0), t0, hours_since_issue, model="test")
    last_safe = max(
        lead
        for lead in range(config.HORIZON_H)
        if config.safe_previous_day(lead, hours_since_issue) <= 2
    )
    columns = ["lead_h", "wx_field", "ws100", "ws10", "temp2m"]
    for lead, field, ws100, ws10, temp in sel[columns].itertuples(index=False):
        n = config.safe_previous_day(lead, hours_since_issue)
        assert field == f"day{n}"
        assert ws100 == 100 * n + lead  # the value of exactly that run, never a fresher one
        assert ws10 == 10 * n + lead  # ws10 from the same run as ws100
        assert temp == 20 + min(lead, last_safe)  # day2-only fields are carried backward only


def _payload_from(frame: pd.DataFrame, lat: float, lon: float) -> dict:
    """Rebuild an Open-Meteo-like JSON object (one point) from a WEATHER_COLUMNS frame."""
    hourly = {"time": [t.strftime("%Y-%m-%dT%H:%M") for t in frame["time_utc"]]}
    for api_name, col in weather.API_VARS.items():
        hourly[api_name] = [None if pd.isna(v) else float(v) for v in frame[col]]
    return {"latitude": lat, "longitude": lon, "elevation": 555.0, "hourly": hourly}


class _Response:
    def __init__(self, payload):
        self.raw = json.dumps(payload).encode()

    def read(self):
        return self.raw

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_request_goes_by_both_turbine_coordinates():
    url = weather.build_url("best_match")
    assert "latitude=43.645150,43.643198" in url and "longitude=78.535604,78.538828" in url


def test_to_frame_accepts_one_point_and_a_list_of_points():
    base = _synthetic(T0_FIRST)
    single = weather.to_frame(_payload_from(base, 43.62, 78.48))
    assert list(single.columns) == WEATHER_COLUMNS and len(single.attrs["cells"]) == 1
    second = base.copy()
    second["ws100_d1"] += 2.0  # the other turbine's cell reports slightly more wind
    cell = (43.62, 78.48)
    both = weather.to_frame([_payload_from(base, *cell), _payload_from(second, *cell)])
    assert list(both.columns) == WEATHER_COLUMNS and len(both) == len(base)
    assert both.attrs["same_cell"] is True and both.attrs["cells"][1]["turbine"] == 2
    assert np.allclose(both["ws100_d1"], base["ws100_d1"] + 1.0)  # farm series = mean of points
    assert np.allclose(both["dir100_d2"], base["dir100_d2"] % 360)  # circular mean of equal angles
    other_cell = weather.to_frame([_payload_from(base, *cell), _payload_from(base, 43.9, 78.7)])
    assert other_cell.attrs["same_cell"] is False


def test_fetch_issue_window_offline_never_raises(monkeypatch):
    monkeypatch.setattr(
        weather.urllib.request, "urlopen", lambda *a, **k: (_ for _ in ()).throw(OSError("down"))
    )
    result = weather.fetch_issue_window(T0_FIRST)
    assert result["live"] is False and "down" in result["reason"]


def test_fetch_issue_window_compares_live_answer_with_cache(monkeypatch, wx):
    last = T0_FIRST + pd.Timedelta(hours=config.HORIZON_H - 1)
    window = wx[(wx["time_utc"] >= T0_FIRST) & (wx["time_utc"] <= last)].reset_index(drop=True)
    points = [_payload_from(window, lat, lon) for lat, lon in weather.turbine_points()]
    monkeypatch.setattr(weather.urllib.request, "urlopen", lambda *a, **k: _Response(points))
    same = weather.fetch_issue_window(T0_FIRST)
    assert same["live"] is True and same["rows"] == config.HORIZON_H and same["mismatches"] == 0
    changed = window.copy()
    changed.loc[5, "ws100_d1"] = changed.loc[5, "ws100_d1"] + 1.0
    points = [_payload_from(changed, lat, lon) for lat, lon in weather.turbine_points()]
    monkeypatch.setattr(weather.urllib.request, "urlopen", lambda *a, **k: _Response(points))
    differs = weather.fetch_issue_window(T0_FIRST)
    assert differs["mismatches"] == 1 and differs["max_abs_diff"] == pytest.approx(1.0)


def test_missing_safe_run_falls_back_to_older_never_fresher():
    wx, lead = _synthetic(T0_FIRST), 20  # lead 20 -> day2 is the safe run
    assert config.safe_previous_day(lead) == 2
    wx.loc[lead, "ws100_d2"] = float("nan")
    sel = weather.select_for_issue(wx, T0_FIRST, model="test")
    assert sel.loc[lead, "wx_field"] == "day3"
    assert sel.loc[lead, "ws100"] == 300 + lead and sel.loc[lead, "ws10"] == 30 + lead


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

"""R2 — archived weather forecasts for the farm (Open-Meteo Previous Runs API), cache-first.

previous_dayN for target hour T comes from a run initialised no later than T - 24N h.
For an issue at t0 each target hour takes the smallest N already published
(config.safe_previous_day); a missing value falls back to an OLDER run (larger N),
never a fresher one, so nothing from after t0 leaks into the forecast.
"""

import hashlib
import json
import os
import urllib.parse
import urllib.request
from datetime import UTC, datetime

import pandas as pd

from app import config
from app.schemas import ISSUE_WEATHER_COLUMNS, WEATHER_COLUMNS

START_DATE = "2024-02-15"
# last issue t0 = 2026-02-27 19:00Z, lead 47 -> 2026-03-01 18:00Z: the cache must reach past 01.03
END_DATE = "2026-03-02"

# API variable -> WEATHER_COLUMNS name
API_VARS = {
    **{f"wind_speed_100m_previous_day{n}": f"ws100_d{n}" for n in (1, 2, 3)},
    **{f"wind_speed_10m_previous_day{n}": f"ws10_d{n}" for n in (1, 2, 3)},
    "wind_direction_100m_previous_day2": "dir100_d2",
    "temperature_2m_previous_day2": "temp2m_d2",
    "wind_gusts_10m_previous_day2": "gust10_d2",
}
# auxiliary fields exist only as previous_day2
AUX = {"dir100": "dir100_d2", "temp2m": "temp2m_d2", "gust10": "gust10_d2"}


def cache_path(model: str):
    return config.WEATHER_CACHE / f"prev_runs_{model}.json"


def build_url(model: str, start: str = START_DATE, end: str = END_DATE) -> str:
    params = {
        "latitude": f"{config.FARM_LAT:.6f}",
        "longitude": f"{config.FARM_LON:.6f}",
        "wind_speed_unit": "ms",
        "timezone": "GMT",
        "hourly": ",".join(API_VARS),
        "start_date": start,
        "end_date": end,
        "models": model,
    }
    return f"{config.WEATHER_API}?{urllib.parse.urlencode(params, safe=',')}"


def fetch_previous_runs(
    model: str, start: str = START_DATE, end: str = END_DATE, timeout: float = 60
) -> dict:
    """Download archived runs, save raw JSON to data/weather_cache/, record it in meta.json."""
    url = build_url(model, start, end)
    with urllib.request.urlopen(url, timeout=timeout) as resp:  # fixed https endpoint
        raw = resp.read()
    payload = json.loads(raw)
    _check_payload(payload)
    config.WEATHER_CACHE.mkdir(parents=True, exist_ok=True)
    # atomic: a failed download must never leave a half-written cache behind
    tmp = cache_path(model).with_suffix(".tmp")
    tmp.write_bytes(raw)
    os.replace(tmp, cache_path(model))
    _update_meta(model, url, raw, start, end)
    return payload


# "no usable answer from Open-Meteo": network/HTTP/timeout (OSError), bad JSON or empty payload
_FETCH_ERRORS = (OSError, ValueError)


def _check_payload(payload) -> None:
    """Reject API errors and empty answers before anything is written to the cache."""
    items = payload if isinstance(payload, list) else [payload]
    for item in items:
        if not isinstance(item, dict) or not item.get("hourly", {}).get("time"):
            reason = item.get("reason", "no hourly data") if isinstance(item, dict) else item
            raise ValueError(f"Open-Meteo returned no usable data: {reason}")


def _update_meta(model: str, url: str, raw: bytes, start: str, end: str) -> None:
    meta_file = config.WEATHER_CACHE / "meta.json"
    try:
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        meta = {}
    if "models" not in meta:  # migrate the initial single-model layout
        meta = {
            "source": "Open-Meteo Previous Runs API (https://open-meteo.com/en/docs/previous-runs-api)"
        }
        meta["models"] = {}
    meta["models"][model] = {
        "url": url,
        "fetched_at": datetime.now(UTC).isoformat(timespec="seconds"),
        "sha256": hashlib.sha256(raw).hexdigest(),
        "start_date": start,
        "end_date": end,
        "timezone": "GMT",
    }
    meta_file.write_text(json.dumps(meta, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def to_frame(payload: dict) -> pd.DataFrame:
    """Open-Meteo JSON -> DataFrame[WEATHER_COLUMNS]; variables absent in the payload become NaN."""
    hourly = payload.get("hourly", {})
    df = pd.DataFrame({"time_utc": pd.to_datetime(hourly.get("time", []), utc=True)})
    for api_name, col in API_VARS.items():
        values = hourly.get(api_name)
        df[col] = (
            pd.to_numeric(pd.Series(values), errors="coerce")
            if values is not None
            else float("nan")
        )
    return df[WEATHER_COLUMNS].sort_values("time_utc").reset_index(drop=True)


def load_or_fetch(model: str = "best_match", refresh: bool = False) -> pd.DataFrame:
    """Cache first; fetch only on refresh or without cache.

    A failed fetch falls back to the cache (attrs["source"] = "cache" | "live"). Without any
    cache the error is explicit — an empty frame would surface later as a cryptic ValidationError.
    """
    path = cache_path(model)
    reason = None
    if refresh or not path.exists():
        try:
            df = to_frame(fetch_previous_runs(model))
            df.attrs.update(model=model, source="live")
            return df
        except _FETCH_ERRORS as exc:  # network down / API error: use the committed cache
            reason = f"{type(exc).__name__}: {exc}"
    if not path.exists():
        raise FileNotFoundError(
            f"weather cache {path} is missing and Open-Meteo is unreachable ({reason}); "
            f"run load_or_fetch({model!r}, refresh=True) with network access"
        )
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise ValueError(
            f"weather cache {path} is unreadable ({exc}); delete it and run "
            f"load_or_fetch({model!r}, refresh=True)"
        ) from exc
    df = to_frame(payload)
    df.attrs.update(model=model, source="cache")
    return df


def select_for_issue(
    wx: pd.DataFrame, issue_time_utc, hours_since_issue: int = 0, model: str | None = None
) -> pd.DataFrame:
    """48 target hours from t0: weather each hour could have known at t0 + hours_since_issue.

    ws100/ws10 use previous_dayN with N >= safe_previous_day(lead); if dayN is missing,
    an older run (N+1..3). dir100/temp2m/gust10 exist only as day2: where day2 is not yet
    safe (lead >= 42) they are carried forward from the last safe hour.
    """
    t0 = pd.Timestamp(issue_time_utc)
    t0 = t0.tz_localize("UTC") if t0.tzinfo is None else t0.tz_convert("UTC")
    last = t0 + pd.Timedelta(hours=config.HORIZON_H - 1)
    if wx.empty or t0 < wx["time_utc"].min() or last > wx["time_utc"].max():
        covered = "nothing" if wx.empty else f"{wx['time_utc'].min()}..{wx['time_utc'].max()}"
        raise ValueError(
            f"weather cache covers {covered}, issue window {t0}..{last} is outside it; "
            "run load_or_fetch(refresh=True) or extend START_DATE/END_DATE"
        )
    wx_model = model or wx.attrs.get("model", "best_match")
    by_time = wx.set_index("time_utc")
    rows = []
    for lead in range(config.HORIZON_H):
        target = t0 + pd.Timedelta(hours=lead)
        rec = by_time.loc[target] if target in by_time.index else None
        n_safe = config.safe_previous_day(lead, hours_since_issue)
        ws100 = ws10 = float("nan")
        field = f"day{n_safe}"
        for n in range(n_safe, config.MAX_PREVIOUS_DAY + 1):
            v = rec[f"ws100_d{n}"] if rec is not None else float("nan")
            if pd.notna(v):
                ws100, field = float(v), f"day{n}"
                w = rec[f"ws10_d{n}"]
                ws10 = float(w) if pd.notna(w) else float("nan")
                break
        aux_ok = rec is not None and n_safe <= 2
        row = {
            "target_time_utc": target,
            "lead_h": lead,
            "wx_field": field,
            "wx_model": wx_model,
            "ws100": ws100,
            "ws10": ws10,
        }
        for name, col in AUX.items():
            row[name] = float(rec[col]) if aux_ok and pd.notna(rec[col]) else float("nan")
        rows.append(row)
    out = pd.DataFrame(rows)
    # carry day2-only fields forward where day2 is not yet published (leak-safe direction)
    out[list(AUX)] = out[list(AUX)].ffill()
    return out[ISSUE_WEATHER_COLUMNS]

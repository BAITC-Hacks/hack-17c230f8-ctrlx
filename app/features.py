"""R3 — leak-safe weather selection for many issues at once, and model features.

Training and the live forecast go through the same selector: every (issue, lead) row takes
the freshest previous_dayN that was already published at the issue time (config.safe_previous_day),
falling back to OLDER runs only. Tests compare it with app.weather.select_for_issue row by row.
"""

from datetime import date, datetime, timedelta

import numpy as np
import pandas as pd

from app.config import HORIZON_H, LOCAL_TZ, MAX_PREVIOUS_DAY, safe_previous_day

# best_match switched its source at this grid point: ICON before, ECMWF IFS HRES from 2025-10-01.
NWP_EPOCH_SWITCH = pd.Timestamp("2025-10-01", tz="UTC")

FEATURES = [
    "ws100",
    "ws100_3",
    "ws10",
    "shear",
    "gust10",
    "dir_sin",
    "dir_cos",
    "temp2m",
    "inv_t",
    "hour_sin",
    "hour_cos",
    "month",
    "lead",
    "field",
    "nwp_epoch",
    "pc",
]


def issue_time_utc(obs_day: date) -> pd.Timestamp:
    """Issue for observation day D: D+1 00:00 local, after all of day D is observed."""
    local = datetime(obs_day.year, obs_day.month, obs_day.day, tzinfo=LOCAL_TZ) + timedelta(days=1)
    return pd.Timestamp(local).tz_convert("UTC")


def issue_times(first: date, last: date) -> list[pd.Timestamp]:
    days = pd.date_range(first, last, freq="D")
    return [issue_time_utc(d.date()) for d in days]


def select_many(
    wx: pd.DataFrame, t0s: list[pd.Timestamp], hours_since_issue: int = 0
) -> pd.DataFrame:
    """Rows (t0, lead 0..47): leak-safe ws100/ws10 and day2-only aux fields, as of t0 + hours."""
    by_time = wx.set_index("time_utc").sort_index()
    leads = np.arange(HORIZON_H)
    t0_arr = np.repeat(
        pd.DatetimeIndex(t0s).tz_convert("UTC").tz_localize(None).to_numpy(), HORIZON_H
    )
    lead_arr = np.tile(leads, len(t0s))
    target = pd.DatetimeIndex(t0_arr + lead_arr.astype("timedelta64[h]"), tz="UTC")
    nsafe = np.array([safe_previous_day(int(lead), hours_since_issue) for lead in leads])
    nsafe = np.tile(nsafe, len(t0s))
    sub = by_time.reindex(target)
    ws100 = np.full(len(target), np.nan)
    ws10 = np.full(len(target), np.nan)
    field = np.zeros(len(target), dtype=int)
    for n in range(1, MAX_PREVIOUS_DAY + 1):
        cand = sub[f"ws100_d{n}"].to_numpy()
        cand10 = sub[f"ws10_d{n}"].to_numpy()
        take = (field == 0) & (nsafe <= n) & np.isfinite(cand)
        ws100[take], ws10[take], field[take] = cand[take], cand10[take], n
    out = pd.DataFrame(
        {
            "t0": pd.DatetimeIndex(t0_arr, tz="UTC"),
            "target": target,
            "lead": lead_arr,
            "field": field,
            "ws100": ws100,
            "ws10": ws10,
        }
    )
    aux_ok = nsafe <= 2  # aux fields exist only as previous_day2
    for src, name in (("dir100_d2", "dir100"), ("temp2m_d2", "temp2m"), ("gust10_d2", "gust10")):
        v = sub[src].to_numpy().copy()
        v[~aux_ok] = np.nan
        out[name] = v
    out[["dir100", "temp2m", "gust10"]] = out.groupby("t0")[["dir100", "temp2m", "gust10"]].ffill()
    return out


def add_features(frame: pd.DataFrame, curves: dict) -> pd.DataFrame:
    """Model features; `curves` maps field N -> fitted farm PowerCurve (MOS on forecast ws100)."""
    d = frame.copy()
    d["ws100_3"] = d["ws100"] ** 3
    d["shear"] = d["ws100"] / d["ws10"].clip(lower=0.5)
    rad = np.deg2rad(d["dir100"])
    d["dir_sin"], d["dir_cos"] = np.sin(rad), np.cos(rad)
    d["inv_t"] = 1.0 / (d["temp2m"] + 273.15)
    local = pd.DatetimeIndex(d["target"]).tz_convert(LOCAL_TZ)
    d["hour_sin"] = np.sin(2 * np.pi * local.hour / 24)
    d["hour_cos"] = np.cos(2 * np.pi * local.hour / 24)
    d["month"] = local.month
    d["nwp_epoch"] = (pd.DatetimeIndex(d["target"]) >= NWP_EPOCH_SWITCH).astype(int)
    d["pc"] = np.nan
    for n, curve in curves.items():
        m = d["field"] == n
        d.loc[m, "pc"] = curve.predict(d.loc[m, "ws100"].to_numpy())
    return d

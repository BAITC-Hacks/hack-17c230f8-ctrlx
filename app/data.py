"""R1 — historical SCADA data: raw 10-minute CSVs -> hourly per turbine and farm series (UTC)."""

import pandas as pd

from app.config import (
    DATA_RAW,
    DATA_TZ,
    HOURLY_PATH,
    LOCAL_TZ,
    MIN_SAMPLES_PER_HOUR,
    TURBINES,
)
from app.schemas import HOURLY_COLUMNS

RAW_COLUMNS = ["id", "time", "ws", "power", "temp"]
DOWNTIME_WS = 5.0
DOWNTIME_POWER = 0.01


def load_raw(turbine_id: int) -> pd.DataFrame:
    """One turbine, 10-minute rows: time_utc, ws, power, temp."""
    df = pd.read_csv(DATA_RAW / TURBINES[turbine_id].raw_file)
    df.columns = RAW_COLUMNS
    naive = pd.to_datetime(df["time"], format="%Y-%m-%d %H:%M:%S")
    df["time_utc"] = naive.dt.tz_localize(DATA_TZ).dt.tz_convert("UTC")
    return df[["time_utc", "ws", "power", "temp"]]


def to_hourly(df: pd.DataFrame) -> pd.DataFrame:
    """Hour-start mean; an hour with fewer than MIN_SAMPLES_PER_HOUR samples is a gap (NaN)."""
    hour = df["time_utc"].dt.floor("h")
    g = df.groupby(hour).agg(
        ws=("ws", "mean"), power=("power", "mean"), temp=("temp", "mean"), n_samples=("ws", "size")
    )
    full = pd.date_range(g.index.min(), g.index.max(), freq="h", tz="UTC")
    g = g.reindex(full)
    g["n_samples"] = g["n_samples"].fillna(0).astype(int)
    g["flag_gap"] = g["n_samples"] < MIN_SAMPLES_PER_HOUR
    g.loc[g["flag_gap"], ["ws", "power", "temp"]] = float("nan")
    g["flag_downtime"] = (g["ws"] > DOWNTIME_WS) & (g["power"] <= DOWNTIME_POWER)
    g.index.name = "time_utc"
    return g.reset_index()


def build_hourly(save: bool = True) -> pd.DataFrame:
    """Long table (time_utc, turbine) per HOURLY_COLUMNS; prints the assumptions it made."""
    parts = []
    for tid in TURBINES:
        h = to_hourly(load_raw(tid))
        h["turbine"] = tid
        parts.append(h)
        print(
            f"turbine {tid}: {h['time_utc'].min():%Y-%m-%d} … {h['time_utc'].max():%Y-%m-%d}, "
            f"{len(h)} h, gaps {h['flag_gap'].mean():.1%}, downtime {h['flag_downtime'].mean():.1%}"
        )
    out = pd.concat(parts, ignore_index=True)
    out["time_local"] = out["time_utc"].dt.tz_convert(LOCAL_TZ)
    out = out[HOURLY_COLUMNS]
    if save:
        HOURLY_PATH.parent.mkdir(parents=True, exist_ok=True)
        out.to_parquet(HOURLY_PATH, index=False)
    return out


def farm_hourly(hourly: pd.DataFrame | None = None) -> pd.DataFrame:
    """R1: p is the equal-capacity farm mean, known only when both turbines are observed.

    Missing SCADA is not zero generation and one turbine is not a farm-level label.
    Its available observation is still retained for the per-turbine model.
    """
    if hourly is None:
        hourly = pd.read_parquet(HOURLY_PATH) if HOURLY_PATH.exists() else build_hourly()
    w = hourly.pivot(index="time_utc", columns="turbine", values=["power", "ws", "temp"])
    out = pd.DataFrame(index=w.index)
    for tid in TURBINES:
        out[f"p{tid}"] = w[("power", tid)]
        out[f"ws{tid}"] = w[("ws", tid)]
    out["p"] = out[[f"p{t}" for t in TURBINES]].mean(axis=1, skipna=False)
    out["temp"] = w["temp"].mean(axis=1)
    return out

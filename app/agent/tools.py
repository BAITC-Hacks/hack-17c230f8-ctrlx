"""Agent tools (lead's zone). Deterministic functions that compute every number; the orchestrator
decides which to call and what to do with the result, the optional LLM only explains.

Heavy inputs (history, weather archive, trained model) are loaded once per process.
"""

from functools import cache

import numpy as np
import pandas as pd

from app import config, weather
from app.data import farm_hourly
from app.features import select_many
from app.models import PowerCurve, WindCastModel, persistence
from app.train import load as load_model

TOOL_SPECS: list[dict] = []  # for the LLM planner: name, description, JSON schema


def tool(description: str, parameters: dict | None = None):
    def wrap(fn):
        TOOL_SPECS.append(
            {
                "name": fn.__name__,
                "description": description,
                "parameters": parameters or {"type": "object", "properties": {}},
            }
        )
        return fn

    return wrap


@cache
def facts() -> pd.DataFrame:
    return farm_hourly()


@cache
def model() -> WindCastModel:
    return load_model()


@cache
def _weather(name: str, refresh: bool) -> pd.DataFrame:
    return weather.load_or_fetch(name, refresh=refresh)


@cache
def gfs_curves() -> dict:
    """Power curves on gfs_seamless wind, used only when the primary source fails validation."""
    wx = _weather("gfs_seamless", False).set_index("time_utc")
    hist = wx.join(facts()[["p"]], how="inner")
    hist = hist[hist.index < model().train_end]
    return {n: PowerCurve().fit(hist[f"ws100_d{n}"], hist["p"]) for n in (1, 2, 3)}


@tool("Load archived NWP runs (Open-Meteo Previous Runs) for the farm coordinates")
def fetch_weather(model_name: str = "best_match", refresh: bool = False) -> pd.DataFrame:
    return _weather(model_name, refresh)


@tool("Pick, for each of the 48 target hours, the freshest run already published at the issue")
def select_weather(wx: pd.DataFrame, t0: pd.Timestamp, hours_since_issue: int = 0) -> pd.DataFrame:
    return select_many(wx, [t0], hours_since_issue)


@tool("Check coverage, ranges, run admissibility and NWP source of the selected weather")
def validate_weather(sel: pd.DataFrame, t0: pd.Timestamp, hours_since_issue: int = 0) -> dict:
    lo, hi = config.WS_VALID_RANGE
    ws = sel["ws100"]
    admissible = all(
        f >= config.safe_previous_day(int(lead), hours_since_issue)
        for f, lead in zip(sel["field"], sel["lead"], strict=True)
        if f > 0
    )
    covered = int(ws.notna().sum())
    in_range = bool(((ws >= lo) & (ws <= hi)).all()) if covered else False
    return {
        "covered": covered,
        "hours": len(sel),
        "in_range": in_range,
        "admissible": admissible,
        "fields": {f"day{int(k)}": int(v) for k, v in sel["field"].value_counts().items() if k},
        "ok": covered == len(sel) and in_range and admissible,
        "source": "ECMWF IFS HRES" if t0 >= pd.Timestamp("2025-10-01", tz="UTC") else "DWD ICON",
    }


@tool("Mean wind of the primary source over the last 30 days vs the training period")
def source_shift(wx: pd.DataFrame, t0: pd.Timestamp) -> dict:
    w = wx.set_index("time_utc")["ws100_d2"]
    recent = w[(w.index >= t0 - pd.Timedelta(days=30)) & (w.index < t0)].mean()
    train = w[(w.index < model().train_end)].mean()
    return {"recent_mean_ws": round(float(recent), 2), "train_mean_ws": round(float(train), 2)}


@tool("Run a model: gbm (LightGBM + CQR), power_curve, climatology or gfs_power_curve")
def run_model(sel: pd.DataFrame, model_name: str) -> pd.DataFrame:
    if model_name == "gfs_power_curve":
        out = pd.DataFrame({"target": sel["target"].to_numpy(), "lead": sel["lead"].to_numpy()})
        pred = np.full(len(sel), np.nan)
        for n, curve in gfs_curves().items():
            m = (sel["field"] == n).to_numpy()
            pred[m] = curve.predict(sel.loc[m, "ws100"].to_numpy())
        pred = np.clip(pred, 0, 1)
        res = model().meta["pc_residual_q"]
        out["pc"] = pred
        out["power_farm"] = out["power_t1"] = out["power_t2"] = pred
        out["p10"] = np.clip(pred + res[0], 0, 1)
        out["p90"] = np.clip(pred + res[1], 0, 1)
        return out
    return model().predict(sel, model_name)


@tool("Validate a forecast and list dispatcher risks (ramps, calm, cold, low confidence)")
def analyze(
    pred: pd.DataFrame, sel: pd.DataFrame, gfs_sel: pd.DataFrame | None, offset: float = 0.0
) -> dict:
    p = pred["power_farm"].to_numpy()
    finite = bool(np.isfinite(p).all())
    ordered = bool((pred["p10"] <= pred["power_farm"] + 1e-9).all()) and bool(
        (pred["power_farm"] <= pred["p90"] + 1e-9).all()
    )
    flat = bool(np.nanstd(p) < config.FLATLINE_STD and np.nanmean(sel["ws100"]) > 6)
    gap = float(np.nanmean(np.abs(p - pred["pc"].to_numpy())))
    ws_max = float(np.nanmax(sel["ws100"])) if sel["ws100"].notna().any() else float("nan")
    out_of_range = bool(ws_max > model().ws_train_max * 1.1)
    checks = {
        "finite": finite,
        "ordered_quantiles": ordered,
        "no_flatline": not flat,
        "close_to_power_curve": gap <= config.MAX_MEAN_GAP_TO_POWER_CURVE,
        "wind_inside_training_range": not out_of_range,
    }
    local = pd.DatetimeIndex(pred["target"]).tz_convert(config.LOCAL_TZ)
    ramp = np.abs(pd.Series(p).diff(config.RAMP_HOURS).to_numpy()) >= config.RAMP_DELTA
    t, ws = sel["temp2m"].to_numpy(), sel["ws100"].to_numpy()
    cold = (t > config.COLD_RISK_TEMP[0]) & (t <= config.COLD_RISK_TEMP[1])
    cold &= (ws >= config.COLD_RISK_WS[0]) & (ws <= config.COLD_RISK_WS[1])
    wide = (pred["p90"] - pred["p10"]).to_numpy() > config.WIDE_INTERVAL
    risks = {
        "ramp_hours": [f"{h:%d.%m %H:%M}" for h in local[ramp]],
        "calm_hours": int((p < config.CALM_LEVEL).sum()),
        "cold_risk_hours": int(cold.sum()),
        "wide_interval_hours": int(wide.sum()),
    }
    if gfs_sel is not None:
        # systematic winter offset between the sources is removed first (GFS runs windier)
        spread = np.abs(sel["ws100"].to_numpy() - gfs_sel["ws100"].to_numpy() - offset)
        risks["nwp_disagree_hours"] = int(np.nansum(spread > config.NWP_SPREAD_WS))
    return {
        "ok": all(checks.values()),
        "checks": checks,
        "gap_to_power_curve": round(gap, 3),
        "risks": risks,
    }


def _local_label(ts: pd.Timestamp) -> str:
    return f"{ts.tz_convert(config.LOCAL_TZ):%d.%m %H:%M}"


@tool("Compare the agent's own published issues with facts that arrived since, test for drift")
def reflect(t0: pd.Timestamp, out_dir) -> dict:
    """Only out-of-sample evidence: forecasts this agent published earlier vs facts known at t0."""
    f = facts()
    facts_end = f["p"].last_valid_index() + pd.Timedelta(hours=1)
    known_until = min(t0, facts_end)
    rows = []
    for path in sorted(out_dir.glob("issue_*.csv")):
        d = pd.read_csv(path)
        d["t0"] = pd.to_datetime(d["issue_time_utc"], utc=True)
        d["target"] = pd.to_datetime(d["target_time_utc"], utc=True)
        d = d[(d["t0"] < t0) & (d["t0"] >= t0 - pd.Timedelta(days=config.DRIFT_DAYS))]
        d = d[(d["lead_h"] < 24) & (d["target"] < known_until)]
        d = d.sort_values("revision").drop_duplicates("target", keep="last")
        rows.append(d)
    got = pd.concat(rows) if rows else pd.DataFrame()
    base = {
        "frozen": bool(facts_end < t0),
        "facts_until": _local_label(facts_end - pd.Timedelta(hours=1)),
    }
    if got.empty:
        return {**base, "n": 0, "drift": False}
    e = got["power_farm"].to_numpy() - f["p"].reindex(got["target"]).to_numpy()
    ok = np.isfinite(e)
    daily = pd.Series(e[ok]).groupby(got["t0"].to_numpy()[ok]).mean()
    if len(daily) < 3:
        return {**base, "n": int(ok.sum()), "drift": False}
    t_stat = float(daily.mean() / (daily.std(ddof=1) / np.sqrt(len(daily)) + 1e-9))
    return {
        **base,
        "n": int(ok.sum()),
        "days": int(len(daily)),
        "mae": round(float(np.abs(e[ok]).mean()), 3),
        "bias": round(float(e[ok].mean()), 3),
        "t_stat": round(t_stat, 2),
        "drift": abs(t_stat) > config.DRIFT_T_STAT,
    }


@tool("Typical offset between the two NWP sources over the 30 days before the issue")
def nwp_offset(wx: pd.DataFrame, wg: pd.DataFrame, t0: pd.Timestamp) -> float:
    a = wx.set_index("time_utc")["ws100_d2"]
    b = wg.set_index("time_utc")["ws100_d2"]
    d = (a - b)[(a.index >= t0 - pd.Timedelta(days=30)) & (a.index < t0 - pd.Timedelta(days=2))]
    return float(d.median()) if d.notna().any() else 0.0


@tool("Mean farm power over the 24 h before the issue (facts known at t0)")
def persistence_level(t0: pd.Timestamp) -> float:
    return persistence(facts(), t0)

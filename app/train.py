"""R3 — train the forecasting models on issues simulated exactly like the test ones.

`uv run python -m app.cli train` fits on everything observed before the first test issue
(2026-02-01 00:00 local) and saves models/windcast.pkl.
"""

import pickle
from datetime import UTC, datetime

import numpy as np
import pandas as pd

from app import weather
from app.config import LOCAL_TZ, MODEL_PATH, TRAIN_END, TRAIN_START
from app.data import farm_hourly
from app.features import FEATURES, add_features, issue_time_utc, select_many
from app.models import COVERAGE, CQR_DAYS, WindCastModel, fit_curves, fit_gbm

TARGETS = ("p", "p1", "p2")


def training_frame(wx: pd.DataFrame, farm: pd.DataFrame, curves: dict, train_end: pd.Timestamp):
    first = issue_time_utc(TRAIN_START)
    t0s = [t for t in pd.date_range(first, train_end, freq="D", tz="UTC") if t < train_end]
    # issue times are local midnights: rebuild them per day so DST-free UTC+5/UTC+6 is exact
    t0s = [issue_time_utc((t.tz_convert(LOCAL_TZ) - pd.Timedelta(days=1)).date()) for t in t0s]
    fr = select_many(wx, sorted(set(t0s)))
    fr = fr[(fr["target"] < train_end) & fr["ws100"].notna()]
    for t in TARGETS:
        fr[t] = farm[t].reindex(fr["target"]).to_numpy()
    return add_features(fr, curves)


def train(train_end: pd.Timestamp, wx: pd.DataFrame | None = None, farm=None) -> WindCastModel:
    wx = weather.load_or_fetch("best_match") if wx is None else wx
    farm = farm_hourly() if farm is None else farm
    start = issue_time_utc(TRAIN_START) - pd.Timedelta(days=1)
    hist = wx.set_index("time_utc").join(farm[list(TARGETS)], how="inner")
    hist = hist[(hist.index >= start) & (hist.index < train_end)]
    curves = {t: fit_curves(hist, t) for t in TARGETS}

    x = training_frame(wx, farm, curves["p"], train_end)
    gbm = {}
    for t in TARGETS:
        rows = x[x[t].notna()]
        gbm[t] = fit_gbm(rows, rows[t], "regression_l1")

    # conformalised quantiles: fit on all but the last CQR_DAYS, calibrate on them
    farm_rows = x[x["p"].notna()]
    cal_start = train_end - pd.Timedelta(days=CQR_DAYS)
    fit_rows, cal_rows = (
        farm_rows[farm_rows["t0"] < cal_start],
        farm_rows[farm_rows["t0"] >= cal_start],
    )
    gbm["q10"] = fit_gbm(fit_rows, fit_rows["p"], "quantile", 0.1)
    gbm["q90"] = fit_gbm(fit_rows, fit_rows["p"], "quantile", 0.9)
    lo = gbm["q10"].predict(cal_rows[FEATURES])
    hi = gbm["q90"].predict(cal_rows[FEATURES])
    y = cal_rows["p"].to_numpy()
    score = np.maximum(np.minimum(lo, hi) - y, y - np.maximum(lo, hi))
    n = len(score)
    qhat = float(np.quantile(score, min(1.0, np.ceil((n + 1) * COVERAGE) / n)))

    res = (farm_rows["p"] - farm_rows["pc"]).dropna()
    local = farm.index[farm.index < train_end].tz_convert(LOCAL_TZ)
    clim = farm.loc[farm.index < train_end, "p"].groupby([local.month, local.hour]).mean()
    return WindCastModel(
        train_end=train_end,
        curves=curves,
        gbm=gbm,
        cqr_qhat=qhat,
        climatology=clim,
        ws_train_max=float(x["ws100"].max()),
        meta={
            "rows": int(len(farm_rows)),
            "issues": int(farm_rows["t0"].nunique()),
            "cal_rows": int(n),
            "pc_residual_q": (float(res.quantile(0.1)), float(res.quantile(0.9))),
            "features": FEATURES,
            "created_at": datetime.now(UTC).isoformat(timespec="seconds"),
        },
    )


def save(model: WindCastModel) -> None:
    MODEL_PATH.parent.mkdir(parents=True, exist_ok=True)
    with MODEL_PATH.open("wb") as f:
        pickle.dump(model, f)


def load() -> WindCastModel:
    with MODEL_PATH.open("rb") as f:
        return pickle.load(f)


def production_train_end() -> pd.Timestamp:
    """The first test issue (obs day 31.01.2026) sees everything before 01.02.2026 00:00 local."""
    return issue_time_utc(TRAIN_END)


def main(argv: list[str]) -> int:
    end = production_train_end()
    model = train(end)
    save(model)
    print(
        f"trained on {model.meta['issues']} issues / {model.meta['rows']} rows before {end} UTC; "
        f"CQR q̂={model.cqr_qhat:+.3f}; saved {MODEL_PATH.name}"
    )
    return 0

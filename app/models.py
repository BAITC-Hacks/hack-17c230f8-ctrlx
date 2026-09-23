"""R3 — forecasting models: power curve (MOS on forecast wind), gradient boosting (scikit-learn
HistGradientBoosting) median + quantiles with conformal (CQR) calibration, climatology baseline."""

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from app.config import LOCAL_TZ, MAX_PREVIOUS_DAY
from app.features import FEATURES, add_features

# Fixed before any hold-out check, never tuned on test months.
# scikit-learn's histogram GBM: same algorithm family as LightGBM, but its wheels ship their own
# OpenMP runtime, so it runs on a clean macOS without Homebrew libomp (LightGBM's wheel needs it).
GBM_PARAMS = dict(
    learning_rate=0.03,
    max_iter=500,
    max_leaf_nodes=15,
    min_samples_leaf=50,
    early_stopping=False,
    random_state=0,
)
CQR_DAYS = 60
COVERAGE = 0.8
FIELDS = range(1, MAX_PREVIOUS_DAY + 1)


class PowerCurve:
    """Mean target per 0.5 m/s bin of forecast wind (bins with < min_n samples dropped)."""

    def __init__(self, width: float = 0.5, min_n: int = 10):
        self.width, self.min_n = width, min_n

    def fit(self, x, y) -> "PowerCurve":
        x, y = np.asarray(x, float), np.asarray(y, float)
        ok = np.isfinite(x) & np.isfinite(y)
        s = pd.DataFrame({"b": np.floor(x[ok] / self.width), "y": y[ok]}).groupby("b")["y"]
        s = s.agg(["mean", "size"])
        s = s[s["size"] >= self.min_n]
        self.centers = (s.index.to_numpy() + 0.5) * self.width
        self.values = np.maximum.accumulate(s["mean"].to_numpy())  # monotone in wind speed
        return self

    def predict(self, x) -> np.ndarray:
        x = np.asarray(x, float)
        out = np.interp(x, self.centers, self.values)
        out[~np.isfinite(x)] = np.nan
        return out


@dataclass
class WindCastModel:
    train_end: pd.Timestamp
    curves: dict  # target -> {field: PowerCurve}; targets "p", "p1", "p2"
    gbm: dict  # "p", "p1", "p2" -> L1 median model; "q10", "q90" -> quantile models
    cqr_qhat: float
    climatology: pd.Series  # (month, local hour) -> mean farm power
    ws_train_max: float
    meta: dict = field(default_factory=dict)

    def features(self, frame: pd.DataFrame) -> pd.DataFrame:
        return add_features(frame, self.curves["p"])

    def predict(self, frame: pd.DataFrame, model_name: str = "gbm") -> pd.DataFrame:
        """frame from features.select_many -> power_t1, power_t2, power_farm, p10, p90, pc."""
        x = self.features(frame)
        out = pd.DataFrame({"target": x["target"].to_numpy(), "lead": x["lead"].to_numpy()})
        out["pc"] = np.clip(x["pc"].to_numpy(), 0, 1)
        if model_name == "gbm":
            for key, col in (("p", "power_farm"), ("p1", "power_t1"), ("p2", "power_t2")):
                out[col] = np.clip(self.gbm[key].predict(x[FEATURES]), 0, 1)
            lo = self.gbm["q10"].predict(x[FEATURES]) - self.cqr_qhat
            hi = self.gbm["q90"].predict(x[FEATURES]) + self.cqr_qhat
        elif model_name == "power_curve":
            for key, col in (("p", "power_farm"), ("p1", "power_t1"), ("p2", "power_t2")):
                pred = np.full(len(x), np.nan)
                for n in FIELDS:
                    m = (x["field"] == n).to_numpy()
                    pred[m] = self.curves[key][n].predict(x.loc[m, "ws100"].to_numpy())
                out[col] = np.clip(pred, 0, 1)
            res = self.meta["pc_residual_q"]
            lo, hi = out["power_farm"] + res[0], out["power_farm"] + res[1]
        elif model_name == "climatology":
            local = pd.DatetimeIndex(x["target"]).tz_convert(LOCAL_TZ)
            keys = list(zip(local.month, local.hour, strict=True))
            clim = self.climatology.reindex(keys).to_numpy()
            out["power_farm"] = out["power_t1"] = out["power_t2"] = clim
            lo, hi = clim - 0.3, clim + 0.3
        else:
            raise ValueError(f"unknown model {model_name}")
        p50 = out["power_farm"].to_numpy()
        out["p10"] = np.clip(np.minimum(lo, p50), 0, 1)
        out["p90"] = np.clip(np.maximum(hi, p50), 0, 1)
        return out


def fit_gbm(x: pd.DataFrame, y: pd.Series, objective: str, alpha: float | None = None):
    from sklearn.ensemble import HistGradientBoostingRegressor

    loss = {"regression_l1": "absolute_error", "quantile": "quantile"}[objective]
    kw = {"loss": loss, **({"quantile": alpha} if alpha is not None else {})}
    return HistGradientBoostingRegressor(**GBM_PARAMS, **kw).fit(x[FEATURES], y)


def fit_curves(hist: pd.DataFrame, target: str) -> dict:
    """hist: hourly weather joined with facts; one curve per previous_dayN field."""
    return {n: PowerCurve().fit(hist[f"ws100_d{n}"], hist[target]) for n in FIELDS}


def persistence(farm: pd.DataFrame, t0: pd.Timestamp) -> float:
    """Mean farm power over the 24 h before t0 (facts known at t0 only)."""
    past = farm.loc[(farm.index >= t0 - pd.Timedelta(hours=24)) & (farm.index < t0), "p"]
    return float(past.mean()) if past.notna().any() else float("nan")

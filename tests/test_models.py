"""R3/R7: time-separated CQR training and inference, including legacy artifacts."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from app import train as training
from app.config import MAX_PREVIOUS_DAY
from app.features import FEATURES, select_many
from app.models import PowerCurve, WindCastModel


class FeaturePredictor:
    def __init__(self, offset=0.0):
        self.offset = offset

    def predict(self, x):
        return x["pc"].to_numpy() + self.offset


def synthetic_history():
    times = pd.date_range("2025-01-01", "2025-01-12", freq="h", tz="UTC")
    wx = pd.DataFrame({"time_utc": times})
    for n in range(1, MAX_PREVIOUS_DAY + 1):
        wx[f"ws100_d{n}"] = 8.0
        wx[f"ws10_d{n}"] = 5.0
    wx["dir100_d2"], wx["temp2m_d2"], wx["gust10_d2"] = 180.0, 5.0, 10.0
    farm = pd.DataFrame({"p": 0.2, "p1": 0.2, "p2": 0.2}, index=times)
    return wx, farm


def test_calibration_targets_cannot_fit_quantile_models_or_features(monkeypatch):
    """Poison later labels: point curves may change, quantile training must not."""
    monkeypatch.setattr(training, "TRAIN_START", date(2025, 1, 1))
    monkeypatch.setattr(training, "CQR_DAYS", 2)
    calls = []

    def fit(x, y, objective, alpha=None):
        calls.append((objective, x.copy(), y.copy()))
        return FeaturePredictor((alpha - 0.5) * 0.1 if alpha else 0.0)

    monkeypatch.setattr(training, "fit_gbm", fit)
    wx, farm = synthetic_history()
    end = pd.Timestamp("2025-01-11", tz="UTC")
    cal_start = end - pd.Timedelta(days=2)
    clean = training.train(end, wx, farm)
    clean_calls = calls.copy()
    calls.clear()
    poisoned = farm.copy()
    poisoned.loc[poisoned.index >= cal_start, :] = 0.9
    changed = training.train(end, wx, poisoned)

    for (objective, clean_x, clean_y), (_, changed_x, changed_y) in zip(
        clean_calls, calls, strict=True
    ):
        if objective == "quantile":
            assert clean_x["target"].max() < cal_start
            pd.testing.assert_frame_equal(clean_x[FEATURES], changed_x[FEATURES])
            pd.testing.assert_series_equal(clean_y, changed_y)
    assert clean.curves["p"][1].predict([8.0])[0] != changed.curves["p"][1].predict([8.0])[0]
    assert clean.quantile_curves[1].predict([8.0])[0] == pytest.approx(0.2)
    assert changed.quantile_curves[1].predict([8.0])[0] == pytest.approx(0.2)
    assert pd.Timestamp(clean.meta["quantile_fit_target_end"]) < pd.Timestamp(
        clean.meta["cal_target_start"]
    )
    assert clean.meta["cal_rows"] > 0


def test_conformal_offset_uses_finite_sample_rank():
    # ceil((10+1)*.8)=9: the ninth observed score is 8, not an interpolated 8.1.
    assert training.conformal_offset(np.arange(10.0)) == 8.0
    with pytest.raises(ValueError, match="finite, non-empty"):
        training.conformal_offset(np.array([]))


def test_quantile_inference_uses_its_own_curves_and_legacy_artifacts_still_load():
    wx, _ = synthetic_history()
    frame = select_many(wx, [pd.Timestamp("2025-01-05", tz="UTC")])

    def curves(value):
        return {
            n: PowerCurve().fit(np.full(20, 8.0), np.full(20, value))
            for n in range(1, MAX_PREVIOUS_DAY + 1)
        }

    model = WindCastModel(
        train_end=pd.Timestamp("2025-01-01", tz="UTC"),
        curves={target: curves(0.6) for target in ("p", "p1", "p2")},
        gbm={target: FeaturePredictor() for target in ("p", "p1", "p2", "q10", "q90")},
        cqr_qhat=0.1,
        climatology=pd.Series(dtype=float),
        ws_train_max=8.0,
        quantile_curves=curves(0.3),
    )
    prediction = model.predict(frame)
    assert np.allclose(prediction["power_farm"], 0.6)
    assert np.allclose(prediction["p10"], 0.2)
    del model.quantile_curves  # pre-fix pickle has no such instance attribute
    legacy = model.predict(frame)
    assert np.allclose(legacy["power_farm"], 0.6)
    assert np.allclose(legacy["p10"], 0.5)

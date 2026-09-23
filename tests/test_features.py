"""Keep platform math differences away from discontinuous tree split thresholds."""

import numpy as np
import pandas as pd
import pytest

from app.features import FEATURES, add_features
from app.models import PowerCurve


def feature_input():
    return pd.DataFrame(
        {
            "target": pd.date_range("2026-02-22", periods=24, freq="h", tz="UTC"),
            "lead": np.arange(24),
            "field": 1,
            "ws100": 8.1,
            "ws10": 5.3,
            "gust10": 10.2,
            "temp2m": -3.1,
            "dir100": np.tile([53.00000000000001, 60.0, 300.0], 8),
        }
    )


@pytest.mark.parametrize("direction", [np.inf, -np.inf])
def test_canonical_features_remove_platform_math_ulps(monkeypatch, direction):
    frame = feature_input()
    curve = PowerCurve().fit(np.full(20, 8.0), np.full(20, 0.3))
    curves = {1: curve}
    expected = add_features(frame, curves)
    # The reported Windows/macOS discrepancy at direction 53 degrees was one
    # ULP in cos(), sufficient to move a turbine prediction from .6265 to .7166.
    for name in ("sin", "cos", "interp"):
        original = getattr(np, name)

        def shifted(*args, _original=original, **kwargs):
            return np.nextafter(_original(*args, **kwargs), direction)

        monkeypatch.setattr(np, name, shifted)
    actual = add_features(frame, curves)
    pd.testing.assert_frame_equal(actual[FEATURES], expected[FEATURES], check_exact=True)


def test_equivalent_cyclic_values_have_identical_features():
    frame = feature_input()
    frame.loc[0, "ws10"] = np.nan
    x = add_features(frame, {})
    assert x.loc[1, "dir_cos"] == x.loc[2, "dir_cos"]  # cos(60) = cos(300)
    assert x.loc[1, "dir_sin"] == -x.loc[2, "dir_sin"]
    assert x.loc[1, "hour_sin"] == -x.loc[13, "hour_sin"]
    assert np.isnan(x.loc[0, "shear"])  # missing-value semantics remain intact

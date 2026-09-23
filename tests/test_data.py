"""R1: station-level targets retain their meaning when SCADA is incomplete."""

import numpy as np
import pandas as pd
import pytest

from app.data import farm_hourly


def test_farm_target_requires_both_turbines_without_losing_individual_targets():
    times = pd.date_range("2026-01-01", periods=3, freq="h", tz="UTC")
    hourly = pd.DataFrame(
        {
            "time_utc": list(times) * 2,
            "turbine": [1] * 3 + [2] * 3,
            "power": [0.2, 0.4, np.nan, 0.6, np.nan, 0.8],
            "ws": [8.0] * 6,
            "temp": [5.0] * 6,
        }
    )
    farm = farm_hourly(hourly)
    assert farm.loc[times[0], "p"] == pytest.approx(0.4)
    assert farm.loc[times[1:], "p"].isna().all()
    assert farm.loc[times[1], "p1"] == pytest.approx(0.4)
    assert farm.loc[times[2], "p2"] == pytest.approx(0.8)

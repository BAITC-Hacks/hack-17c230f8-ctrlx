"""Project-wide constants: paths, turbine coordinates, time conventions, leakage rule."""

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo, reset_tzpath

# Time-zone rules come from the pinned `tzdata` package, never from the OS: an old system database
# (before 2024a) still puts Almaty at UTC+6 and would shift every issue by an hour on that machine.
reset_tzpath(to=[])

ROOT = Path(__file__).resolve().parent.parent
DATA_RAW = ROOT / "data" / "raw"
DATA_PROCESSED = ROOT / "data" / "processed"
WEATHER_CACHE = ROOT / "data" / "weather_cache"
MODELS_DIR = ROOT / "models"
OUTPUTS_FORECASTS = ROOT / "outputs" / "forecasts"
OUTPUTS_METRICS = ROOT / "outputs" / "metrics"
RUNS_DIR = ROOT / "runs"

HOURLY_PATH = DATA_PROCESSED / "hourly.parquet"
HOURLY_META = DATA_PROCESSED / "hourly.meta.json"  # sha256 of the raw CSVs behind the parquet
FEBRUARY_PATH = OUTPUTS_FORECASTS / "february_2026.csv"


@dataclass(frozen=True)
class Turbine:
    id: int
    lat: float
    lon: float
    raw_file: str


# Coordinates from the task statement (Google Maps links). ~300 m apart: one weather grid cell.
TURBINES: dict[int, Turbine] = {
    1: Turbine(1, 43.645150, 78.535604, "turbine1.csv"),
    2: Turbine(2, 43.643198, 78.538828, "turbine2.csv"),
}
FARM_LAT = 43.645150
FARM_LON = 78.535604

# Display / issue time zone. Kazakhstan is UTC+5 since 2024-03-01, so the test month is UTC+5.
LOCAL_TZ = ZoneInfo("Asia/Almaty")
# "Статистическое время" in the raw CSVs: a fixed UTC+5 clock for the whole series. The SCADA clock
# did not jump on 2024-03-01 (diurnal temperature phase shifts by +6 min, not +60), and the
# lag to Open-Meteo forecasts peaks at +5 h. Everything else is stored in UTC.
DATA_TZ = ZoneInfo("Etc/GMT-5")

# Raw data step is 10 minutes; an hour needs at least this many samples, otherwise NaN.
RAW_STEP_MIN = 10
MIN_SAMPLES_PER_HOUR = 4

# Issue convention: "forecast on day D" = made at D+1 00:00 local with observations through D 23:50,
# covering the next 48 hours: lead 0–23 h = "24h horizon", 24–47 h = "48h horizon".
HORIZON_H = 48
TEST_ISSUE_FIRST = date(2026, 1, 31)  # observation day D; t0 = 2026-02-01 00:00 local
TEST_ISSUE_LAST = date(2026, 2, 27)  # t0 = 2026-02-28 00:00 local; covers 28.02 and 01.03
TRAIN_END = date(2026, 1, 31)  # last observed day, inclusive

# Training window: the previous-runs archive starts mid-February 2024.
TRAIN_START = date(2024, 2, 18)
# Model outputs, persisted by `python -m app.cli train`.
MODEL_PATH = MODELS_DIR / "windcast.pkl"

# Weather: Open-Meteo Previous Runs API. previous_dayN for target hour T comes from a model run
# initialised no later than T - 24N h. Runs are published with a delay; we require
# init + PUBLISH_DELAY_H <= t0 (+ hours elapsed since t0 on an intraday refresh).
WEATHER_API = "https://previous-runs-api.open-meteo.com/v1/forecast"
WEATHER_MODELS = ("best_match", "gfs_seamless")  # primary, fallback / spread indicator
# Measured availability on Open-Meteo: IFS HRES 7.0 h, IFS 0.25° 7.8 h, GFS 5.5-6.5 h, ICON 3.8 h.
PUBLISH_DELAY_H = 7
MAX_PREVIOUS_DAY = 3
INTRADAY_REFRESH_H = 12  # "input data updated": recompute at t0 + 12 h with fresher runs
# Intraday corrections: not later than 2 h before the hour (wholesale market rules p. 97-99).
CORRECTION_MIN_LEAD_H = INTRADAY_REFRESH_H + 2
RATED_MW = 5.0  # VES "Nurly": 2 x Goldwind GW109/2500 (the whole plant is in the data)

# Agent thresholds, fixed before any replay (see docs/SOLUTION.md, section 8.3).
WS_VALID_RANGE = (0.0, 40.0)  # m/s
MAX_MEAN_GAP_TO_POWER_CURVE = 0.25  # model vs physical prior, share of rated power
FLATLINE_STD = 0.01  # a flat forecast while the wind is strong is a failure
RAMP_DELTA, RAMP_HOURS = 0.3, 3  # ramp risk: |change| >= 0.3 of rated within 3 h
CALM_LEVEL = 0.05
COLD_RISK_TEMP = (-10.0, 1.0)  # °C, with forecast wind 5-8 m/s (winter under-production)
COLD_RISK_WS = (5.0, 8.0)
WIDE_INTERVAL = 0.6
NWP_SPREAD_WS = 3.0  # m/s between best_match and gfs_seamless
MATERIAL_MEAN_DELTA, MATERIAL_MAX_DELTA = 0.05, 0.2  # recompute counts as a real change
DRIFT_T_STAT, DRIFT_DAYS = 2.0, 7
SOURCE_SHIFT_WS = 1.0  # m/s: 30-day mean forecast wind vs training mean (NWP source change / drift)


def safe_previous_day(lead_h: int, hours_since_issue: int = 0) -> int:
    """Smallest N such that previous_dayN was already published at t0 + hours_since_issue.

    lead 0..16 -> 1, 17..40 -> 2, 41..64 -> 3 (at hours_since_issue = 0). Conservative on purpose.
    """
    n = (lead_h + PUBLISH_DELAY_H - hours_since_issue) // 24 + 1
    return max(1, min(MAX_PREVIOUS_DAY, n))

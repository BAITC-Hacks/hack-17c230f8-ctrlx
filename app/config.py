"""Project-wide constants: paths, turbine coordinates, time conventions, leakage rule."""

from dataclasses import dataclass
from datetime import date
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
DATA_RAW = ROOT / "data" / "raw"
DATA_PROCESSED = ROOT / "data" / "processed"
WEATHER_CACHE = ROOT / "data" / "weather_cache"
MODELS_DIR = ROOT / "models"
OUTPUTS_FORECASTS = ROOT / "outputs" / "forecasts"
OUTPUTS_METRICS = ROOT / "outputs" / "metrics"
RUNS_DIR = ROOT / "runs"

HOURLY_PATH = DATA_PROCESSED / "hourly.parquet"
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

# "Статистическое время" in the raw CSVs is Almaty local time (UTC+6 before 2024-03-01, then UTC+5);
# zoneinfo handles the switch. Everything else is stored in UTC.
LOCAL_TZ = ZoneInfo("Asia/Almaty")

# Raw data step is 10 minutes; an hour needs at least this many samples, otherwise NaN.
RAW_STEP_MIN = 10
MIN_SAMPLES_PER_HOUR = 4

# Issue convention: "forecast on day D" = made at D+1 00:00 local with observations through D 23:50,
# covering the next 48 hours: lead 0–23 h = "24h horizon", 24–47 h = "48h horizon".
HORIZON_H = 48
TEST_ISSUE_FIRST = date(2026, 1, 31)  # observation day D; t0 = 2026-02-01 00:00 local
TEST_ISSUE_LAST = date(2026, 2, 27)  # t0 = 2026-02-28 00:00 local; covers 28.02 and 01.03
TRAIN_END = date(2026, 1, 31)  # last observed day, inclusive

# Weather: Open-Meteo Previous Runs API. previous_dayN for target hour T comes from a model run
# initialised no later than T - 24N h. Runs are published with a delay; we require
# init + PUBLISH_DELAY_H <= t0 (+ hours elapsed since t0 on an intraday refresh).
WEATHER_API = "https://previous-runs-api.open-meteo.com/v1/forecast"
WEATHER_MODELS = ("best_match", "gfs_seamless")  # primary, fallback / spread indicator
PUBLISH_DELAY_H = 6
MAX_PREVIOUS_DAY = 3
INTRADAY_REFRESH_H = 12  # "input data updated": recompute at t0 + 12 h with fresher runs


def safe_previous_day(lead_h: int, hours_since_issue: int = 0) -> int:
    """Smallest N such that previous_dayN was already published at t0 + hours_since_issue.

    lead 0..17 -> 1, 18..41 -> 2, 42..65 -> 3 (at hours_since_issue = 0). Conservative on purpose.
    """
    n = (lead_h + PUBLISH_DELAY_H - hours_since_issue) // 24 + 1
    return max(1, min(MAX_PREVIOUS_DAY, n))

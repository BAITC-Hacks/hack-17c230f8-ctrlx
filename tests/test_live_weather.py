"""Live weather window for dates the committed archive does not cover (docs/SOLUTION.md §5.6)."""

import urllib.request
from datetime import date

import pandas as pd

from app import weather
from app.agent import tools
from app.features import issue_time_utc


def test_covered_date_always_uses_the_archive_even_with_refresh():
    t0 = issue_time_utc(date(2026, 2, 10))
    archive = weather.load_or_fetch("best_match")
    frame, info = tools.weather_for_issue("best_match", t0, refresh=True)
    assert info["covered"] and info["source"] == "archive"
    pd.testing.assert_frame_equal(frame, archive)


def test_uncovered_date_offline_stays_on_the_archive(monkeypatch):
    def offline(*args, **kwargs):
        raise OSError("no network")

    monkeypatch.setattr(urllib.request, "urlopen", offline)
    t0 = issue_time_utc(date(2026, 9, 22))
    frame, info = tools.weather_for_issue("best_match", t0, refresh=False)
    assert not info["covered"] and info["source"] == "archive" and info["live_error"] == "OSError"
    assert not tools.archive_covers(frame, t0)

"""Leak-proofness and determinism of the agent (docs/SOLUTION.md, section 6)."""

from datetime import date

import numpy as np
import pandas as pd
import pytest

from app import config, weather
from app.agent import tools
from app.agent.log import RunLog
from app.agent.orchestrator import run_issue
from app.features import issue_time_utc, select_many
from app.models import persistence

ISSUE = date(2026, 1, 31)
REQUIRED_STEPS = {
    "plan",
    "fetch_weather",
    "validate_weather",
    "prepare",
    "run_model",
    "analyze",
    "recompute_if_updated",
    "reflect",
    "write_report",
}


@pytest.fixture(scope="module")
def issue_run(tmp_path_factory):
    out = tmp_path_factory.mktemp("forecasts")
    runs = tmp_path_factory.mktemp("runs")
    issue = run_issue(ISSUE, out_dir=out, runs_dir=runs)
    return issue, out, runs


def test_issue_has_full_horizon_and_every_agent_step(issue_run):
    issue, _, runs = issue_run
    rev0 = [r for r in issue.rows if r.revision == 0]
    assert [r.lead_h for r in rev0] == list(range(config.HORIZON_H))
    assert all(r.lead_h >= config.CORRECTION_MIN_LEAD_H for r in issue.rows if r.revision == 1)
    steps = RunLog.read(issue.run_id, base_dir=runs)
    assert REQUIRED_STEPS <= {s.tool for s in steps}
    assert all(s.decision for s in steps if s.tool in {"validate_weather", "analyze"})


def test_every_row_uses_a_run_published_before_the_issue(issue_run):
    issue, _, _ = issue_run
    for r in issue.rows:
        assert r.wx_field != "none", "a normal issue has admissible weather for every hour"
        hours_since = config.INTRADAY_REFRESH_H if r.revision == 1 else 0
        n = int(r.wx_field.removeprefix("day"))
        assert n >= config.safe_previous_day(r.lead_h, hours_since), r


def test_issue_writes_a_day_ahead_bid_in_mwh(issue_run):
    issue, _, runs = issue_run
    bids = list((runs / issue.run_id).glob("bid_*.csv"))
    assert len(bids) == 1
    bid = pd.read_csv(bids[0])
    assert len(bid) == 24
    assert (bid["plan_mwh"] >= 0).all() and (bid["plan_mwh"] <= config.RATED_MW).all()
    assert (bid["p10_mwh"] <= bid["plan_mwh"] + 1e-9).all()


def test_every_used_run_was_available_before_the_issue(issue_run):
    """Provenance in the log: the newest run behind any hour was published before t0."""
    issue, _, runs = issue_run
    val = next(s for s in RunLog.read(issue.run_id, base_dir=runs) if s.tool == "validate_weather")
    assert val.args["min_margin_h"] >= 0


def test_poisoned_future_does_not_change_the_forecast():
    """Replace everything unknown at t0 with garbage: the forecast must stay the same."""
    t0 = issue_time_utc(ISSUE)
    wx = weather.load_or_fetch("best_match")
    clean = tools.model().predict(select_many(wx, [t0]), "gbm")

    poisoned = wx.copy()
    lead = ((poisoned["time_utc"] - t0) / pd.Timedelta(hours=1)).to_numpy()
    for n in (1, 2, 3):
        # previous_dayN for this hour was not yet published at t0
        bad = np.array(
            [
                0 <= int(le) < config.HORIZON_H and n < config.safe_previous_day(int(le))
                if np.isfinite(le)
                else False
                for le in lead
            ]
        )
        poisoned.loc[bad, [f"ws100_d{n}", f"ws10_d{n}"]] = 999.0
        if n == 2:
            poisoned.loc[bad, ["dir100_d2", "temp2m_d2", "gust10_d2"]] = 999.0
    dirty = tools.model().predict(select_many(poisoned, [t0]), "gbm")
    pd.testing.assert_frame_equal(clean, dirty)

    facts = tools.facts().copy()
    facts.loc[facts.index >= t0, :] = 999.0
    assert persistence(facts, t0) == persistence(tools.facts(), t0)


def test_issue_inside_the_training_period_is_refused(tmp_path):
    with pytest.raises(ValueError, match="период обучения"):
        run_issue(date(2026, 1, 10), out_dir=tmp_path / "f", runs_dir=tmp_path / "r")


def test_batch_selector_matches_the_weather_module():
    """Training uses features.select_many, the weather module has its own selector: same rows."""
    t0 = issue_time_utc(ISSUE)
    wx = weather.load_or_fetch("best_match")
    for hours in (0, config.INTRADAY_REFRESH_H):
        a = select_many(wx, [t0], hours)
        b = weather.select_for_issue(wx, t0, hours)
        assert a["field"].tolist() == [int(f.removeprefix("day")) for f in b["wx_field"]]
        np.testing.assert_allclose(a["ws100"], b["ws100"])


def test_agent_is_deterministic(issue_run, tmp_path):
    _, out, _ = issue_run
    run_issue(ISSUE, out_dir=tmp_path / "f", runs_dir=tmp_path / "r")
    name = f"issue_{ISSUE.isoformat()}.csv"
    assert (out / name).read_bytes() == (tmp_path / "f" / name).read_bytes()

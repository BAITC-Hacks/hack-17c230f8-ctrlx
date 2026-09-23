"""R5: exercise failure paths and publication isolation without training or network."""

import csv
import json
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest

from app.agent import orchestrator, tools
from app.agent.log import RunLog
from app.agent.storage import issue_lock, publish_files
from app.features import issue_time_utc
from app.schemas import ForecastRow

ISSUE = date(2026, 1, 31)


@pytest.fixture
def fake_pipeline(monkeypatch):
    t0 = issue_time_utc(ISSUE)
    state = {"broken_weather": set(), "calls": [], "fail": set(), "invalid": set()}
    model = SimpleNamespace(train_end=t0, cqr_qhat=0, meta={"rows": 48}, ws_train_max=40)
    monkeypatch.setattr(tools, "model", lambda: model)
    monkeypatch.setattr(
        tools,
        "facts",
        lambda: pd.DataFrame(
            {"p": [0.4]},
            index=pd.DatetimeIndex([t0 - pd.Timedelta(hours=1)]),
        ),
    )
    monkeypatch.setattr(
        tools,
        "fetch_weather",
        lambda name, refresh: pd.DataFrame(
            {
                "time_utc": [t0],
                "source": [name],
            }
        ),
    )
    # the live window belongs to real dates outside the archive; here the stub IS the archive
    monkeypatch.setattr(
        tools,
        "weather_for_issue",
        lambda name, t0_, refresh: (
            tools.fetch_weather(name, refresh),
            {"source": "archive", "covered": True},
        ),
    )

    def select_weather(wx, t0, hours_since_issue=0):
        source = wx["source"].iloc[0]
        wind = np.full(48, np.nan) if source in state["broken_weather"] else np.linspace(2, 10, 48)
        return pd.DataFrame(
            {
                "target": pd.date_range(t0, periods=48, freq="h"),
                "lead": np.arange(48),
                "field": 2 if hours_since_issue else 3,
                "ws100": wind,
                "temp2m": 5.0,
            }
        )

    monkeypatch.setattr(tools, "select_weather", select_weather)
    monkeypatch.setattr(tools, "mask_invalid", lambda wx: wx)
    monkeypatch.setattr(
        tools,
        "source_shift",
        lambda *args: {
            "recent_mean_ws": 6,
            "train_mean_ws": 6,
            "source_shift": False,
        },
    )
    monkeypatch.setattr(tools, "nwp_offset", lambda *args: 0.0)
    monkeypatch.setattr(tools, "persistence_level", lambda *args: 0.4)
    monkeypatch.setattr(
        tools,
        "reflect",
        lambda *args: {
            "n": 0,
            "drift": False,
            "facts_until": "31.01 23:00",
            "frozen": False,
        },
    )

    def run_model(sel, name):
        state["calls"].append(name)
        if name in state["fail"]:
            raise ValueError("test-only model exception")
        p = np.linspace(0.2, 0.6, len(sel))
        out = pd.DataFrame(
            {
                "target": sel["target"],
                "lead": sel["lead"],
                "power_farm": p,
                "power_t1": p,
                "power_t2": p,
                "p10": p - 0.1,
                "p90": p + 0.1,
                "pc": p,
            }
        )
        if name in state["invalid"]:
            out.loc[0, "power_t2"] = np.nan
        return out

    monkeypatch.setattr(tools, "run_model", run_model)
    return state


@pytest.mark.parametrize("failure", ["fail", "invalid"])
def test_failed_or_nonfinite_turbine_model_uses_checked_fallback(fake_pipeline, tmp_path, failure):
    fake_pipeline[failure].add("gbm")
    issue = orchestrator.run_issue(ISSUE, out_dir=tmp_path / "f", runs_dir=tmp_path / "r")
    assert issue.model_name == "power_curve" and issue.fallback_used
    assert fake_pipeline["calls"][:2] == ["gbm", "power_curve"]
    assert all(np.isfinite(row.power_t2) for row in issue.rows)
    steps = RunLog.read(issue.run_id, tmp_path / "r")
    assert any(step.tool == "analyze" and step.decision == "accept" for step in steps)


@pytest.mark.parametrize("invalid_gfs", [False, True])
def test_gfs_uses_acceptance_ladder_and_records_analysis(fake_pipeline, tmp_path, invalid_gfs):
    fake_pipeline["broken_weather"].add("best_match")
    if invalid_gfs:
        fake_pipeline["invalid"].add("gfs_power_curve")
    issue = orchestrator.run_issue(ISSUE, out_dir=tmp_path / "f", runs_dir=tmp_path / "r")
    assert fake_pipeline["calls"][0] == "gfs_power_curve"
    assert issue.model_name == ("climatology" if invalid_gfs else "power_curve")
    assert issue.fallback_used
    steps = RunLog.read(issue.run_id, tmp_path / "r")
    assert any(step.tool == "analyze" and step.decision == "accept" for step in steps)
    if invalid_gfs:
        assert any(step.decision == "fallback → climatology" for step in steps)


def test_final_invalid_model_preserves_previous_successful_artifacts(fake_pipeline, tmp_path):
    out_dir, runs_dir = tmp_path / "f", tmp_path / "r"
    issue = orchestrator.run_issue(ISSUE, out_dir=out_dir, runs_dir=runs_dir)
    before = {
        path.relative_to(tmp_path): path.read_bytes()
        for path in tmp_path.rglob("*")
        if path.is_file()
    }
    fake_pipeline["invalid"].update(orchestrator.FALLBACK_LADDER)
    with pytest.raises(ValueError, match="Ни одна модель"):
        orchestrator.run_issue(ISSUE, out_dir=out_dir, runs_dir=runs_dir)
    assert (runs_dir / issue.run_id / "report.md").exists()
    after = {
        path.relative_to(tmp_path): path.read_bytes()
        for path in tmp_path.rglob("*")
        if path.is_file()
    }
    assert before == after
    assert not list(runs_dir.glob(".stage-*"))


def test_weather_outage_roundtrips_csv_and_api_as_null(fake_pipeline, tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from app.api import routes
    from app.main import app

    fake_pipeline["broken_weather"].update({"best_match", "gfs_seamless"})
    out_dir, runs_dir = tmp_path / "f", tmp_path / "r"
    issue = orchestrator.run_issue(ISSUE, out_dir=out_dir, runs_dir=runs_dir)
    assert issue.model_name == "climatology"
    assert all(row.ws100_fc is None and row.wx_field == "none" for row in issue.rows)
    with (out_dir / f"issue_{ISSUE}.csv").open() as stream:
        rows = [ForecastRow.model_validate(row) for row in csv.DictReader(stream)]
    assert all(row.ws100_fc is None for row in rows)
    monkeypatch.setattr(routes, "OUTPUTS_FORECASTS", out_dir)
    monkeypatch.setattr(routes, "RUNS_DIR", runs_dir)
    monkeypatch.setattr(routes, "_read_log", lambda run_id: RunLog.read(run_id, runs_dir))
    response = TestClient(app).get(f"/api/forecast/{ISSUE}")
    assert response.status_code == 200
    assert all(row["ws100_fc"] is None for row in response.json()["rows"])
    assert "NaN" not in response.text


@pytest.mark.parametrize("value", [None, "", " ", "NaN", float("nan"), float("inf")])
def test_missing_wind_schema_normalization(fake_pipeline, tmp_path, value):
    issue = orchestrator.run_issue(ISSUE, out_dir=tmp_path / "f", runs_dir=tmp_path / "r")
    row = ForecastRow.model_validate({**issue.rows[0].model_dump(), "ws100_fc": value})
    assert row.ws100_fc is None
    assert json.loads(row.model_dump_json())["ws100_fc"] is None


def test_revision_model_error_keeps_valid_initial_forecast(fake_pipeline, tmp_path, monkeypatch):
    initial_model = tools.run_model
    calls = 0

    def fail_revision(sel, name):
        nonlocal calls
        calls += 1
        if calls == 2:
            raise RuntimeError("revision failure")
        return initial_model(sel, name)

    monkeypatch.setattr(tools, "run_model", fail_revision)
    issue = orchestrator.run_issue(ISSUE, out_dir=tmp_path / "f", runs_dir=tmp_path / "r")
    assert len(issue.rows) == 48 and issue.revision == 0
    steps = RunLog.read(issue.run_id, tmp_path / "r")
    assert any(step.decision == "keep_revision_0" for step in steps)


def test_same_issue_lock_blocks_threads_and_releases_after_exception(tmp_path):
    with issue_lock(tmp_path, ISSUE):
        with ThreadPoolExecutor(max_workers=1) as pool:

            def contend():
                with issue_lock(tmp_path, ISSUE, timeout=0.05):
                    pass

            with pytest.raises(ValueError, match="уже рассчитывается"):
                pool.submit(contend).result()
    with pytest.raises(RuntimeError):
        with issue_lock(tmp_path, ISSUE):
            raise RuntimeError("calculation failed")
    with issue_lock(tmp_path, ISSUE, timeout=0.1):
        pass


def test_os_lock_excludes_another_process_and_releases_on_crash(tmp_path):
    code = (
        "import os, sys\nfrom pathlib import Path\n"
        "from app.agent.storage import issue_lock\n"
        "with issue_lock(Path(sys.argv[1]), sys.argv[2], timeout=0.1):\n"
        "    os._exit(0)\n"
    )
    with issue_lock(tmp_path, ISSUE):
        blocked = subprocess.run(
            [sys.executable, "-c", code, str(tmp_path), str(ISSUE)],
            capture_output=True,
            text=True,
            timeout=10,
        )
        assert blocked.returncode != 0 and "уже рассчитывается" in blocked.stderr
    exited = subprocess.run(
        [sys.executable, "-c", code, str(tmp_path), str(ISSUE)],
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert exited.returncode == 0
    with issue_lock(tmp_path, ISSUE, timeout=0.2):
        pass


def test_publication_failure_rolls_back_already_replaced_files(tmp_path, monkeypatch):
    sources, targets = tmp_path / "stage", tmp_path / "published"
    sources.mkdir()
    targets.mkdir()
    for name in ("report.md", "forecast.csv"):
        (sources / name).write_text("new")
        (targets / name).write_text("old")
    replace = Path.replace
    failed = False

    def fail_once(self, target):
        nonlocal failed
        if Path(target).name == "forecast.csv" and not failed:
            failed = True
            raise OSError("publication failure")
        return replace(self, target)

    monkeypatch.setattr(Path, "replace", fail_once)
    with pytest.raises(OSError, match="publication failure"):
        publish_files([(sources / name, targets / name) for name in ("report.md", "forecast.csv")])
    assert all((targets / name).read_text() == "old" for name in ("report.md", "forecast.csv"))
    assert not list(targets.glob(".publish-*"))

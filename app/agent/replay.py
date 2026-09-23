"""P1 — prove the agent's decisions with facts.

replay(month): the same agent re-lives a month where the outcome is known — the model is trained
strictly before the month, facts arrive day by day, published issues feed the self-check. Output:
ablation (persistence / fixed pipeline / agent) and a decision ledger with measured effects.

faults(): feeds broken inputs to the agent and to a fixed pipeline and records who survives.
"""

import json
import shutil
import tempfile
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd

from app import config, weather
from app.agent import tools
from app.agent.orchestrator import run_issue
from app.data import farm_hourly
from app.features import issue_time_utc, select_many
from app.models import persistence
from app.train import train

REPLAY_DIR = config.ROOT / "outputs" / "replay"
EVIDENCE_DIR = config.ROOT / "outputs" / "evidence"  # ablation, decision ledger, fault injection
FAULT_ISSUE = date(2026, 2, 9)


def _month_bounds(month: str):
    start = date.fromisoformat(f"{month}-01")
    nxt = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    first_obs = date.fromordinal(start.toordinal() - 1)
    days = pd.date_range(first_obs, date.fromordinal(nxt.toordinal() - 2))
    return issue_time_utc(first_obs), issue_time_utc(date.fromordinal(nxt.toordinal() - 1)), days


def _mae(a, b) -> float:
    return round(float(np.mean(np.abs(np.asarray(a) - np.asarray(b)))), 4)


def _ci(deltas: np.ndarray, n_boot: int = 2000) -> list[float]:
    """95 % bootstrap interval of the mean over issues (issues resampled as blocks)."""
    rng = np.random.default_rng(0)
    means = [rng.choice(deltas, len(deltas)).mean() for _ in range(n_boot)]
    return [round(float(np.quantile(means, 0.025)), 4), round(float(np.quantile(means, 0.975)), 4)]


def replay(month: str = "2026-01") -> dict:
    train_end, period_end, days = _month_bounds(month)
    wx, farm = weather.load_or_fetch("best_match"), farm_hourly()
    model = train(train_end, wx, farm)
    base = REPLAY_DIR / month
    shutil.rmtree(base, ignore_errors=True)
    tools.use(model)
    try:
        issues = [
            run_issue(d.date(), out_dir=base / "forecasts", runs_dir=base / "runs") for d in days
        ]
    finally:
        tools.use(None)

    rows = pd.DataFrame([r.model_dump(mode="json") for i in issues for r in i.rows])
    rows["t0"] = pd.to_datetime(rows["issue_time_utc"], utc=True)
    rows["target"] = pd.to_datetime(rows["target_time_utc"], utc=True)
    rows["y"] = farm["p"].reindex(rows["target"]).to_numpy()
    rows = rows[(rows["target"] < period_end) & rows["y"].notna()]
    final = rows.sort_values("revision").drop_duplicates(["t0", "target"], keep="last")
    rev0 = rows[rows["revision"] == 0]

    t0s = sorted(final["t0"].unique())
    sel = select_many(wx, [pd.Timestamp(t) for t in t0s])
    fixed = sel[["t0", "target", "lead"]].copy()
    fixed["pc"] = model.predict(sel, "power_curve")["power_farm"].to_numpy()
    fixed["gbm"] = model.predict(sel, "gbm")["power_farm"].to_numpy()
    fixed["persistence"] = fixed["t0"].map({t: persistence(farm, t) for t in fixed["t0"].unique()})
    fixed = fixed.merge(final[["t0", "target", "power_farm", "y"]], on=["t0", "target"])

    ablation = [
        {
            "variant": "A persistence (mean of the last 24 h)",
            "mae": _mae(fixed["persistence"], fixed["y"]),
        },
        {
            "variant": "B fixed pipeline: power curve, no checks, no recompute",
            "mae": _mae(fixed["pc"], fixed["y"]),
        },
        {
            "variant": "C model only: gradient boosting at t0, no recompute",
            "mae": _mae(fixed["gbm"], fixed["y"]),
        },
        {
            "variant": "D agent: checks, fallbacks, recompute at t0+12 h (published plan)",
            "mae": _mae(fixed["power_farm"], fixed["y"]),
        },
    ]

    # decision ledger: every decision type, how often it fired, what it changed against the facts
    r1 = rows[rows["revision"] == 1].merge(
        rev0[["t0", "target", "power_farm"]], on=["t0", "target"], suffixes=("", "_rev0")
    )
    per_issue = (
        r1.assign(d=(r1["power_farm"] - r1["y"]).abs() - (r1["power_farm_rev0"] - r1["y"]).abs())
        .groupby("t0")["d"]
        .mean()
    )
    choice = fixed.assign(d=(fixed["gbm"] - fixed["y"]).abs() - (fixed["pc"] - fixed["y"]).abs())
    choice_issue = choice.groupby("t0")["d"].mean()
    steps = [
        s
        for i in issues
        for s in __import__("app.agent.log", fromlist=["RunLog"]).RunLog.read(
            i.run_id, base_dir=base / "runs"
        )
    ]
    drift = [s for s in steps if s.tool == "reflect" and (s.decision or "").startswith("drift")]
    switched = [s for s in steps if s.tool == "validate_weather" and s.decision != "proceed"]
    ledger = [
        {
            "decision": "use gradient boosting instead of the power curve (analyze → accept)",
            "fired": int(len(choice_issue)),
            "mean_delta_mae": round(float(choice_issue.mean()), 4),
            "ci95": _ci(choice_issue.to_numpy()),
            "wins": int((choice_issue < 0).sum()),
        },
        {
            "decision": "recompute at t0+12 h with fresher runs (revision 1)",
            "fired": int(len(per_issue)),
            "mean_delta_mae": round(float(per_issue.mean()), 4),
            "ci95": _ci(per_issue.to_numpy()),
            "wins": int((per_issue < 0).sum()),
        },
        {
            "decision": "fallback to a simpler model after a failed check",
            "fired": int(sum(i.fallback_used for i in issues)),
            "mean_delta_mae": None,
        },
        {
            "decision": "switch the weather source after failed validation",
            "fired": len(switched),
            "mean_delta_mae": None,
        },
        {
            "decision": "drift flag from the self-check (recommend retraining, no silent change)",
            "fired": len(drift),
            "mean_delta_mae": None,
            "t_stats": [s.args.get("t_stat") for s in drift],
        },
    ]
    result = {
        "month": month,
        "train_end_utc": train_end.isoformat(),
        "issues": len(issues),
        "rows_scored": int(len(fixed)),
        "note": "negative delta = the decision reduced MAE against the facts",
        "ablation": ablation,
        "decisions": ledger,
    }
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    (EVIDENCE_DIR / f"replay_{month}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result


def _fixed_pipeline(wx: pd.DataFrame, t0: pd.Timestamp) -> np.ndarray:
    sel = select_many(wx, [t0])
    return tools.model().predict(sel, "power_curve")["power_farm"].to_numpy()


def faults() -> dict:
    """Broken inputs: the agent must publish a valid forecast and say why; the pipeline may not."""
    t0 = issue_time_utc(FAULT_ISSUE)
    best = weather.load_or_fetch("best_match")
    gfs = weather.load_or_fetch("gfs_seamless")
    window = (best["time_utc"] >= t0 + pd.Timedelta(hours=10)) & (
        best["time_utc"] < t0 + pd.Timedelta(hours=16)
    )
    ws_cols = [c for c in best.columns if c.startswith(("ws100_", "ws10_"))]

    def broken(frame, mask, value):
        f = frame.copy()
        f.loc[mask, ws_cols] = value
        return f

    cases = {
        "6 hours of wind missing in the primary source": {
            "best_match": broken(best, window, np.nan)
        },
        "wind spike 100 m/s in the primary source": {"best_match": broken(best, window, 100.0)},
        "primary source unavailable": {"best_match": best.iloc[0:0]},
        "both sources broken": {
            "best_match": broken(best, window, np.nan),
            "gfs_seamless": broken(gfs, window, np.nan),
        },
    }
    out = []
    with tempfile.TemporaryDirectory() as tmp:
        for name, frames in cases.items():
            tools.use(None, **frames)
            try:
                issue = run_issue(FAULT_ISSUE, out_dir=Path(tmp) / "f", runs_dir=Path(tmp) / "r")
                p = np.array([r.power_farm for r in issue.rows if r.revision == 0])
                steps = __import__("app.agent.log", fromlist=["RunLog"]).RunLog.read(
                    issue.run_id, base_dir=Path(tmp) / "r"
                )
                val = next(s for s in steps if s.tool == "validate_weather")
                agent = {
                    "valid_hours": int(np.isfinite(p).sum()),
                    "model": issue.model_name,
                    "decision": val.decision,
                    "reason": val.reason,
                }
            except Exception as exc:  # the agent crashing is itself a result worth recording
                agent = {"valid_hours": 0, "error": type(exc).__name__}
            finally:
                tools.use(None, best_match=None, gfs_seamless=None)
            primary = frames.get("best_match", best)
            try:
                fp = _fixed_pipeline(primary, t0)
                ws = select_many(primary, [t0])["ws100"].to_numpy() if len(primary) else fp
                bad = ~np.isfinite(ws) | (ws > config.WS_VALID_RANGE[1])
                ok = np.isfinite(fp) & (fp >= 0) & (fp <= 1)
                pipe = {
                    "valid_hours": int(ok.sum()) if len(fp) else 0,
                    "hours_from_broken_input": int((bad & ok).sum()) if len(fp) else 0,
                    "note": "no checks: broken input is used as is",
                }
            except Exception as exc:
                pipe = {"valid_hours": 0, "error": type(exc).__name__}
            out.append({"case": name, "agent": agent, "fixed_pipeline": pipe})
    result = {"issue": FAULT_ISSUE.isoformat(), "horizon_h": config.HORIZON_H, "cases": out}
    EVIDENCE_DIR.mkdir(parents=True, exist_ok=True)
    (EVIDENCE_DIR / "faults.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    return result

"""R7 — hold-out check: `uv run python -m app.cli evaluate --holdout 2026-01`.

Models are trained strictly before the month, then every issue of the month is replayed as in the
test (same leak-safe weather), and compared with the facts. Writes outputs/metrics/holdout_<m>.json.
"""

import argparse
import json
from datetime import UTC, date, datetime

import numpy as np
import pandas as pd

from app import weather
from app.config import INTRADAY_REFRESH_H, OUTPUTS_METRICS
from app.data import farm_hourly
from app.features import issue_time_utc, select_many
from app.models import persistence
from app.schemas import MetricRow, MetricsReport
from app.train import train

RATED_MW = 5.0  # VES "Nurly": 2 x Goldwind GW109/2500
PRICE_TG_KWH = 22.68  # fixed RES wind tariff (base), tg/kWh
PENALTY_SHARE = 0.3  # coefficients 1.3 / 0.7 outside +-5 % (balancing market rules, p. 132)
CORRECTION_MIN_LEAD = (
    INTRADAY_REFRESH_H + 2
)  # intraday correction not later than 2 h before the hour


def _row(model: str, horizon: str, y, yhat, ref: dict) -> MetricRow:
    e = np.asarray(yhat) - np.asarray(y)
    mae, rmse = float(np.mean(np.abs(e))), float(np.sqrt(np.mean(e**2)))
    return MetricRow(
        model=model,
        horizon=horizon,
        mae=round(mae, 4),
        rmse=round(rmse, 4),
        nmae=round(mae * 100, 2),
        bias=round(float(np.mean(e)), 4),
        skill_vs_persistence=round(1 - mae / ref["persistence"], 3)
        if "persistence" in ref
        else None,
        skill_vs_power_curve=round(1 - mae / ref["power_curve"], 3)
        if "power_curve" in ref
        else None,
        n=len(e),
    )


def evaluate(month: str) -> dict:
    start = date.fromisoformat(f"{month}-01")
    nxt = date(start.year + (start.month == 12), start.month % 12 + 1, 1)
    train_end = issue_time_utc(date.fromordinal(start.toordinal() - 1))
    period_end = issue_time_utc(date.fromordinal(nxt.toordinal() - 1))
    wx, farm = weather.load_or_fetch("best_match"), farm_hourly()
    model = train(train_end, wx, farm)
    days = pd.date_range(
        date.fromordinal(start.toordinal() - 1), date.fromordinal(nxt.toordinal() - 2)
    )
    t0s = [issue_time_utc(d.date()) for d in days]

    fr = select_many(wx, t0s)
    ev = fr[["t0", "target", "lead"]].copy()
    ev["y"] = farm["p"].reindex(fr["target"]).to_numpy()
    g = model.predict(fr, "gbm")
    ev["gbm"], ev["p10"], ev["p90"] = (
        g["power_farm"].to_numpy(),
        g["p10"].to_numpy(),
        g["p90"].to_numpy(),
    )
    ev["power_curve"] = model.predict(fr, "power_curve")["power_farm"].to_numpy()
    ev["persistence"] = ev["t0"].map({t: persistence(farm, t) for t in t0s})
    ev["climatology"] = model.predict(fr, "climatology")["power_farm"].to_numpy()
    ev = ev[(ev["target"] < min(period_end, farm.index.max() + pd.Timedelta(hours=1)))]
    ev = ev.dropna(subset=["y", "gbm", "persistence"])

    rows = []
    for horizon, m in (
        ("24h", ev["lead"] < 24),
        ("48h", ev["lead"] >= 24),
        ("all", ev["lead"] >= 0),
    ):
        s = ev[m]
        ref = {k: float(np.mean(np.abs(s[k] - s["y"]))) for k in ("persistence", "power_curve")}
        for name in ("persistence", "climatology", "power_curve", "gbm"):
            rows.append(_row(name, horizon, s["y"], s[name], ref))

    cover = float(((ev["y"] >= ev["p10"]) & (ev["y"] <= ev["p90"])).mean())
    width = float((ev["p90"] - ev["p10"]).mean())

    # value of the intraday recompute: same (issue, hour) pairs, fresher runs at t0 + 12 h
    fr1 = select_many(wx, t0s, INTRADAY_REFRESH_H)
    g1 = model.predict(fr1, "gbm")
    both = fr[["t0", "target", "lead", "field"]].assign(rev0=g["power_farm"].to_numpy())
    both["rev1"], both["field1"] = g1["power_farm"].to_numpy(), fr1["field"].to_numpy()
    both["y"] = farm["p"].reindex(both["target"]).to_numpy()
    both = both[(both["lead"] >= CORRECTION_MIN_LEAD) & both["y"].notna()]
    both = both[both["target"] < period_end]
    changed = both[both["field"] != both["field1"]]

    def mae(a, b):
        return round(float(np.mean(np.abs(a - b))), 4)

    plan, fact = ev["gbm"].to_numpy(), ev["y"].to_numpy()
    dev = np.abs(fact - plan)
    corridor = {
        f"within_{k}pct": round(float(np.mean(dev <= k / 100 * plan)), 3) for k in (5, 20, 30)
    }
    hours = ev["target"].nunique()
    cost = {
        name: round(
            float(np.mean(np.abs(ev[name] - fact)))
            * RATED_MW
            * hours
            * PENALTY_SHARE
            * PRICE_TG_KWH
            * 1000
            / 1e6,
            2,
        )
        for name in ("persistence", "power_curve", "gbm")
    }
    extras = {
        "issues": int(ev["t0"].nunique()),
        "interval_p10_p90": {
            "coverage": round(cover, 3),
            "mean_width": round(width, 3),
            "cqr_qhat": round(model.cqr_qhat, 4),
        },
        "recompute_t0_plus_12h": {
            "pairs": len(both),
            "mae_rev0": mae(both["rev0"], both["y"]),
            "mae_rev1": mae(both["rev1"], both["y"]),
            "changed_field_pairs": len(changed),
            "mae_rev0_changed": mae(changed["rev0"], changed["y"]) if len(changed) else None,
            "mae_rev1_changed": mae(changed["rev1"], changed["y"]) if len(changed) else None,
        },
        "regulator_kpi_gbm": corridor,
        "imbalance_cost_upper_bound_mln_tg": {
            "assumptions": f"{RATED_MW} MW, {PRICE_TG_KWH} tg/kWh, penalty {PENALTY_SHARE} x price "
            "for every kWh (all hours outside +-5 %), new-contract regime",
            **cost,
        },
        "accuracy_1_minus_nmae_gbm": round(1 - float(np.mean(dev)), 3),
    }
    report = MetricsReport(
        period=month,
        train_end=train_end.date(),
        rows=rows,
        created_at=datetime.now(UTC),
    )
    return {**report.model_dump(mode="json"), "extras": extras}


def main(argv: list[str]) -> int:
    p = argparse.ArgumentParser(prog="python -m app.evaluate")
    p.add_argument("--holdout", default="2026-01", help="YYYY-MM")
    args = p.parse_args(argv)
    result = evaluate(args.holdout)
    OUTPUTS_METRICS.mkdir(parents=True, exist_ok=True)
    out = OUTPUTS_METRICS / f"holdout_{args.holdout}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for r in result["rows"]:
        if r["horizon"] == "all":
            print(
                f"{r['model']:12s} MAE {r['mae']:.4f}  RMSE {r['rmse']:.4f}  nMAE {r['nmae']:5.2f}%"
            )
    print(json.dumps(result["extras"], ensure_ascii=False, indent=1))
    return 0

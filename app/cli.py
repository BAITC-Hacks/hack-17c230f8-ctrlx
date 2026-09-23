"""CLI: `uv run python -m app.cli <command>`.

forecast --issue 2026-01-31 [--refresh] [--llm]   one issue (obs day D, t0 = D+1 00:00 local)
backtest [--from 2026-01-31] [--to 2026-02-27]     sequential issues, writes outputs/forecasts/*
train                                              fit models on data through TRAIN_END (app.train)
evaluate --holdout 2026-01                         hold-out metrics vs baselines (app.evaluate)
replay --month 2026-01                             re-live a month with facts: ablation + ledger
faults                                             broken inputs: agent vs fixed pipeline
"""

import argparse
import json
import sys
from datetime import date
from pathlib import Path

from app.config import TEST_ISSUE_FIRST, TEST_ISSUE_LAST
from app.console import use_utf8


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("forecast", help="one issue")
    f.add_argument("--issue", type=date.fromisoformat, required=True, help="observation day D")
    f.add_argument("--refresh", action="store_true", help="call Open-Meteo instead of the cache")
    f.add_argument("--llm", action="store_true", help="LLM dispatcher summary (needs LLM_API_KEY)")
    f.add_argument(
        "--demo-dir", type=Path, default=None, help="write outputs here, e.g. runs/llm_demo"
    )

    b = sub.add_parser("backtest", help="sequential issues")
    b.add_argument("--from", dest="start", type=date.fromisoformat, default=TEST_ISSUE_FIRST)
    b.add_argument("--to", dest="end", type=date.fromisoformat, default=TEST_ISSUE_LAST)
    b.add_argument("--refresh", action="store_true")

    sub.add_parser("train", help="fit models (app.train)")

    r = sub.add_parser(
        "replay", help="re-live a month with known facts: ablation + decision ledger"
    )
    r.add_argument("--month", default="2026-01", help="YYYY-MM")
    sub.add_parser("faults", help="broken inputs: agent vs fixed pipeline")

    e = sub.add_parser("evaluate", help="hold-out metrics (app.evaluate)")
    e.add_argument("--holdout", default="2026-01", help="YYYY-MM")
    return p


def main(argv: list[str]) -> int:
    use_utf8()
    args = _parser().parse_args(argv)
    try:
        if args.cmd == "forecast":
            from app.service import forecast

            issue = forecast(args.issue, refresh=args.refresh, llm=args.llm, demo_dir=args.demo_dir)
            print(issue.summary)
            print(f"\nrun_id={issue.run_id} rows={len(issue.rows)} warnings={len(issue.warnings)}")
        elif args.cmd == "backtest":
            from app.service import backtest

            issues = backtest(args.start, args.end, refresh=args.refresh)
            for i in issues:
                warn = f" warnings={len(i.warnings)}" if i.warnings else ""
                print(
                    f"{i.issue_date} {i.run_id} {i.model_name} rev={i.revision} "
                    f"rows={len(i.rows)}{warn}"
                )
            print("february_2026.csv written")
        elif args.cmd == "replay":
            from app.agent.replay import replay

            print(json.dumps(replay(args.month), ensure_ascii=False, indent=1))
        elif args.cmd == "faults":
            from app.agent.replay import faults

            print(json.dumps(faults(), ensure_ascii=False, indent=1))
        elif args.cmd == "train":
            from app.train import main as train_main

            return train_main([])
        elif args.cmd == "evaluate":
            from app.evaluate import main as evaluate_main

            return evaluate_main(["--holdout", args.holdout])
    except (FileNotFoundError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

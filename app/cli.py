"""CLI: `uv run python -m app.cli <command>`.

forecast --issue 2026-01-31 [--refresh] [--llm]   one issue (obs day D, t0 = D+1 00:00 local)
backtest [--from 2026-01-31] [--to 2026-02-27]     sequential issues, writes outputs/forecasts/*
train                                              fit models on data through TRAIN_END (app.train)
evaluate --holdout 2026-01                         hold-out metrics vs baselines (app.evaluate)
"""

import argparse
import sys
from datetime import date

from app.config import TEST_ISSUE_FIRST, TEST_ISSUE_LAST
from app.console import use_utf8


def _parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="python -m app.cli", description=__doc__.split("\n")[0])
    sub = p.add_subparsers(dest="cmd", required=True)

    f = sub.add_parser("forecast", help="one issue")
    f.add_argument("--issue", type=date.fromisoformat, required=True, help="observation day D")
    f.add_argument("--refresh", action="store_true", help="call Open-Meteo instead of the cache")
    f.add_argument("--llm", action="store_true", help="LLM planner (needs LLM_API_KEY)")

    b = sub.add_parser("backtest", help="sequential issues")
    b.add_argument("--from", dest="start", type=date.fromisoformat, default=TEST_ISSUE_FIRST)
    b.add_argument("--to", dest="end", type=date.fromisoformat, default=TEST_ISSUE_LAST)
    b.add_argument("--refresh", action="store_true")

    sub.add_parser("train", help="fit models (app.train)")

    e = sub.add_parser("evaluate", help="hold-out metrics (app.evaluate)")
    e.add_argument("--holdout", default="2026-01", help="YYYY-MM")
    return p


def main(argv: list[str]) -> int:
    use_utf8()
    args = _parser().parse_args(argv)
    try:
        if args.cmd == "forecast":
            from app.service import forecast

            issue = forecast(args.issue, refresh=args.refresh, llm=args.llm)
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
        elif args.cmd == "train":
            from app.train import main as train_main

            return train_main([])
        elif args.cmd == "evaluate":
            from app.evaluate import main as evaluate_main

            return evaluate_main(["--holdout", args.holdout])
    except NotImplementedError as exc:
        print(f"not implemented yet: {exc}", file=sys.stderr)
        return 3
    except ImportError as exc:
        print(f"module not ready: {exc}", file=sys.stderr)
        return 3
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

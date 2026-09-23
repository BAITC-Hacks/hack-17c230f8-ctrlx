"""Metrics harness: score the classifier against a labeled dataset.

Runnable as `uv run python -m app.evaluate data/labeled.json`. Pure stdlib
(argparse/csv/json) - no new runtime dependency for a one-off eval script.
"""

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Literal

from app.console import use_utf8
from app.core import analyze_rule_based
from app.schemas import AnalyzeInput

Mode = Literal["rule", "auto"]


def load_rows(path: Path, text_field: str, label_field: str) -> list[tuple[str, str]]:
    """Read (text, expected_label) pairs from a JSON list of objects or a CSV file."""
    if path.suffix.lower() == ".csv":
        with path.open(encoding="utf-8", newline="") as f:
            rows: list[dict[str, str]] = list(csv.DictReader(f))
    else:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(raw, list):
            raise ValueError(f"{path}: expected a JSON list of objects")
        rows = raw

    pairs: list[tuple[str, str]] = []
    for i, row in enumerate(rows):
        if text_field not in row or label_field not in row:
            raise ValueError(f"{path}: row {i} is missing '{text_field}' or '{label_field}'")
        pairs.append((str(row[text_field]), str(row[label_field])))
    return pairs


def predict(text: str, mode: Mode) -> str:
    inp = AnalyzeInput(text=text)
    if mode == "auto":
        # Local import: keeps `--mode rule` (the default) free of the LLM/env setup.
        from app.service import analyze

        return analyze(inp).label
    return analyze_rule_based(inp).label


def confusion_matrix(
    y_true: list[str], y_pred: list[str]
) -> tuple[list[str], dict[str, dict[str, int]]]:
    """Return (sorted label list, {true_label: {predicted_label: count}})."""
    labels = sorted(set(y_true) | set(y_pred))
    matrix: dict[str, dict[str, int]] = {t: dict.fromkeys(labels, 0) for t in labels}
    for t, p in zip(y_true, y_pred, strict=True):
        matrix[t][p] += 1
    return labels, matrix


def per_class_metrics(
    labels: list[str], matrix: dict[str, dict[str, int]]
) -> dict[str, dict[str, float]]:
    """Precision/recall/F1/support per label, derived from the confusion matrix."""
    metrics: dict[str, dict[str, float]] = {}
    for label in labels:
        true_positive = matrix[label][label]
        support = sum(matrix[label].values())
        predicted = sum(matrix[t][label] for t in labels)
        precision = true_positive / predicted if predicted else 0.0
        recall = true_positive / support if support else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        metrics[label] = {"precision": precision, "recall": recall, "f1": f1, "support": support}
    return metrics


def accuracy(y_true: list[str], y_pred: list[str]) -> float:
    if not y_true:
        return 0.0
    correct = sum(1 for t, p in zip(y_true, y_pred, strict=True) if t == p)
    return correct / len(y_true)


def macro_f1(metrics: dict[str, dict[str, float]]) -> float:
    if not metrics:
        return 0.0
    return sum(m["f1"] for m in metrics.values()) / len(metrics)


def render_report(y_true: list[str], y_pred: list[str], *, source: str, mode: Mode) -> str:
    labels, matrix = confusion_matrix(y_true, y_pred)
    metrics = per_class_metrics(labels, matrix)

    lines = [
        "# Отчёт по метрикам",
        "",
        f"- Источник: `{source}`",
        f"- Режим: `{mode}`",
        f"- Строк: {len(y_true)}",
        f"- Accuracy: {accuracy(y_true, y_pred):.3f}",
        f"- Macro-F1: {macro_f1(metrics):.3f}",
        "",
        "## По классам",
        "",
        "| Класс | Precision | Recall | F1 | Support |",
        "|---|---|---|---|---|",
    ]
    for label in labels:
        m = metrics[label]
        lines.append(
            f"| {label} | {m['precision']:.3f} | {m['recall']:.3f} | "
            f"{m['f1']:.3f} | {int(m['support'])} |"
        )

    lines += [
        "",
        "## Матрица ошибок",
        "",
        "| истина \\ прогноз | " + " | ".join(labels) + " |",
        "|" + "---|" * (len(labels) + 1),
    ]
    for true_label in labels:
        row = " | ".join(str(matrix[true_label][pred_label]) for pred_label in labels)
        lines.append(f"| {true_label} | {row} |")
    lines.append("")

    return "\n".join(lines)


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="python -m app.evaluate",
        description="Evaluate the classifier against a labeled dataset; prints a Markdown report.",
    )
    parser.add_argument("data", type=Path, help="JSON list or CSV file with text + label columns")
    parser.add_argument("--text-field", default="text", help="column/key holding the input text")
    parser.add_argument(
        "--label-field", default="label", help="column/key holding the expected label"
    )
    parser.add_argument(
        "--mode",
        choices=["rule", "auto"],
        default="rule",
        help="'rule' = analyze_rule_based (default); 'auto' = app.service.analyze",
    )
    parser.add_argument("--out", type=Path, default=None, help="also write the report to this file")
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    use_utf8()
    args = _parse_args(argv)

    try:
        pairs = load_rows(args.data, args.text_field, args.label_field)
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 2

    if not pairs:
        print(f"error: {args.data}: no rows to evaluate", file=sys.stderr)
        return 2

    y_true = [label for _, label in pairs]
    y_pred = [predict(text, args.mode) for text, _ in pairs]

    report = render_report(y_true, y_pred, source=str(args.data), mode=args.mode)
    print(report)

    if args.out:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(report, encoding="utf-8")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

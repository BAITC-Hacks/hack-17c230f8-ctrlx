import json
import subprocess
import sys
from pathlib import Path

import pytest

from app.evaluate import accuracy, confusion_matrix, macro_f1, per_class_metrics

PROJECT_ROOT = Path(__file__).resolve().parent.parent
LABELED_PATH = PROJECT_ROOT / "data" / "labeled.json"

# Hand-computed: 2/3 correct overall.
# ham:  TP=1, predicted twice (spam->ham, ham->ham) -> precision 1/2, recall 1/1 -> F1 2/3
# spam: TP=1, support 2 (spam->spam, spam->ham)     -> precision 1/1, recall 1/2 -> F1 2/3
Y_TRUE = ["spam", "spam", "ham"]
Y_PRED = ["spam", "ham", "ham"]


def test_confusion_matrix_on_tiny_example():
    labels, matrix = confusion_matrix(Y_TRUE, Y_PRED)
    assert labels == ["ham", "spam"]
    assert matrix == {"ham": {"ham": 1, "spam": 0}, "spam": {"ham": 1, "spam": 1}}


def test_accuracy_on_tiny_example():
    assert accuracy(Y_TRUE, Y_PRED) == pytest.approx(2 / 3)


def test_per_class_metrics_on_tiny_example():
    labels, matrix = confusion_matrix(Y_TRUE, Y_PRED)
    metrics = per_class_metrics(labels, matrix)

    assert metrics["ham"]["precision"] == pytest.approx(0.5)
    assert metrics["ham"]["recall"] == pytest.approx(1.0)
    assert metrics["ham"]["f1"] == pytest.approx(2 / 3)
    assert metrics["ham"]["support"] == 1

    assert metrics["spam"]["precision"] == pytest.approx(1.0)
    assert metrics["spam"]["recall"] == pytest.approx(0.5)
    assert metrics["spam"]["f1"] == pytest.approx(2 / 3)
    assert metrics["spam"]["support"] == 2


def test_macro_f1_on_tiny_example():
    labels, matrix = confusion_matrix(Y_TRUE, Y_PRED)
    metrics = per_class_metrics(labels, matrix)
    assert macro_f1(metrics) == pytest.approx(2 / 3)


def test_accuracy_of_empty_input_is_zero():
    assert accuracy([], []) == 0.0


def test_macro_f1_of_no_classes_is_zero():
    assert macro_f1({}) == 0.0


def test_cli_runs_end_to_end_on_labeled_data():
    result = subprocess.run(
        [sys.executable, "-m", "app.evaluate", str(LABELED_PATH)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr

    expected_rows = len(json.loads(LABELED_PATH.read_text(encoding="utf-8")))
    assert f"Строк: {expected_rows}" in result.stdout
    assert "Accuracy:" in result.stdout
    assert "Macro-F1:" in result.stdout
    assert "## Матрица ошибок" in result.stdout
    # The dataset is built to include mistakes, so accuracy must be non-trivial.
    assert "Accuracy: 1.000" not in result.stdout


def test_cli_out_flag_writes_the_same_report_to_a_file(tmp_path):
    out_path = tmp_path / "nested" / "METRICS.md"
    result = subprocess.run(
        [sys.executable, "-m", "app.evaluate", str(LABELED_PATH), "--out", str(out_path)],
        cwd=PROJECT_ROOT,
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 0, result.stderr
    assert out_path.exists()
    assert out_path.read_text(encoding="utf-8").strip() == result.stdout.strip()


def test_cli_reports_error_on_missing_file():
    result = subprocess.run(
        [sys.executable, "-m", "app.evaluate", str(PROJECT_ROOT / "data" / "missing.json")],
        cwd=PROJECT_ROOT,
        capture_output=True,
        encoding="utf-8",
    )
    assert result.returncode == 2
    assert result.stderr.strip() != ""

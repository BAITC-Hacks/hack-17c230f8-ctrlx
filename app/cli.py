"""CLI: `python -m app.cli <path.json|->`.

Input is a JSON object `{"text": ...}` or a JSON list of such objects.
Prints the analysis result(s) as JSON to stdout.
"""

import json
import sys

from pydantic import ValidationError

from app.console import use_utf8
from app.schemas import AnalyzeInput
from app.service import analyze


def _read_source(path: str) -> str:
    if path == "-":
        return sys.stdin.read()
    with open(path, encoding="utf-8") as f:
        return f.read()


def main(argv: list[str]) -> int:
    use_utf8()
    if len(argv) != 1:
        print("usage: python -m app.cli <path.json|->", file=sys.stderr)
        return 2

    try:
        raw = _read_source(argv[0])
    except OSError as exc:
        print(f"error: cannot read input: {exc}", file=sys.stderr)
        return 2

    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        print(f"error: invalid JSON: {exc}", file=sys.stderr)
        return 2

    items = data if isinstance(data, list) else [data]

    try:
        inputs = [AnalyzeInput.model_validate(item) for item in items]
    except ValidationError as exc:
        print(f"error: invalid input: {exc}", file=sys.stderr)
        return 2

    results = [analyze(inp).model_dump() for inp in inputs]
    output = results if isinstance(data, list) else results[0]
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

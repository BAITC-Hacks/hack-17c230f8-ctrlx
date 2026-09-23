"""PII detection/masking for text that is about to leave the machine (LLM calls).

Kazakhstan personal-data law forbids sending PII to a third-party model, so
`app/service.py` runs this before any LLM request; the rule-based path keeps
the original text since it never leaves the process.
"""

import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal

PiiKind = Literal["iban", "card", "iin", "phone", "email"]


def _luhn_valid(digits: str) -> bool:
    total = 0
    double = False
    for ch in reversed(digits):
        d = int(ch)
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


@dataclass(frozen=True)
class _Rule:
    kind: PiiKind
    pattern: re.Pattern[str]
    placeholder: str
    # Extra check beyond the regex (e.g. Luhn) - return False to leave the match untouched.
    is_valid: Callable[[str], bool] | None = None


# Order matters: each rule runs on the output of the previous one, so a
# masked span (e.g. "[IBAN]") can never be re-matched by a later rule.
_RULES: tuple[_Rule, ...] = (
    _Rule(
        "iban",
        # "KZ" + 2 check digits + 16 alphanumeric, grouped by 4 with optional spaces.
        re.compile(r"(?<![A-Z0-9])KZ\d{2}(?:\s?[A-Z0-9]{4}){4}(?![A-Z0-9])", re.IGNORECASE),
        "[IBAN]",
    ),
    _Rule(
        "card",
        # 13-19 digits, optionally separated by single spaces/dashes.
        re.compile(r"(?<!\d)\d(?:[ -]?\d){12,18}(?!\d)"),
        "[КАРТА]",
        is_valid=lambda m: _luhn_valid(re.sub(r"[ -]", "", m)),
    ),
    _Rule(
        "iin",
        # Standalone 12-digit run only - never a slice of a longer digit run.
        re.compile(r"(?<!\d)\d{12}(?!\d)"),
        "[ИИН]",
    ),
    _Rule(
        "phone",
        # +7 or 8, then a KZ mobile number: 7XX XXX XX XX.
        re.compile(r"(?<!\d)(?:\+7|8)[ -]?\(?7\d{2}\)?[ -]?\d{3}[ -]?\d{2}[ -]?\d{2}(?!\d)"),
        "[ТЕЛЕФОН]",
    ),
    _Rule(
        "email",
        re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"),
        "[EMAIL]",
    ),
)


def _make_replacer(rule: _Rule, found: dict[str, int]) -> Callable[[re.Match[str]], str]:
    def replace(m: re.Match[str]) -> str:
        if rule.is_valid and not rule.is_valid(m.group()):
            return m.group()
        found[rule.kind] += 1
        return rule.placeholder

    return replace


def mask_pii(text: str) -> tuple[str, dict[str, int]]:
    found: dict[str, int] = {rule.kind: 0 for rule in _RULES}
    masked = text

    for rule in _RULES:
        masked = rule.pattern.sub(_make_replacer(rule, found), masked)

    return masked, found

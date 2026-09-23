"""R9 — ask the agent about one issue. Every answer is built from the run's own facts.

Facts of a run: runs/<run_id>/agent_log.jsonl (RunLog.read), the rows of outputs/forecasts/*.csv
that carry this run_id (all revisions) and runs/<run_id>/report.md. Without an LLM key a template
answers (mode "demo"). With a key the LLM writes the text, and every number in it must already exist
in the facts (SOLUTION 8.5: the LLM explains, it never computes); otherwise the template answers and
the reason is recorded in fallback_reason. Sources cited by the LLM are kept only if they name real
facts (a logged step, the issue CSV, report.md).

Honest limit: the number check blocks invented numbers, it does not prove the sentence around a
number is right (a real number can be attached to a wrong claim). That is why the template answer
is the reference and the LLM text is an optional explanation on top of the same facts.

Example questions: «Какой пик завтра?», «Что в 14:00 2 февраля?», «Откуда погода и нет ли утечки?»,
«Что изменилось после пересчёта?», «Насколько можно верить коридору?», «Что делал агент?».
"""

import json
import re
from dataclasses import dataclass, field
from pathlib import Path

import pandas as pd
from pydantic import BaseModel

from app import config, llm
from app.agent.log import RunLog
from app.schemas import AgentStep, AskAnswer

SYSTEM_PROMPT = (
    "Ты аналитик ветроэлектростанции. Отвечай по-русски, коротко (до 6 предложений), без markdown, "
    "ТОЛЬКО по фактам выпуска из сообщения пользователя. Не выдумывай и не пересчитывай числа: "
    "каждое число в ответе должно дословно присутствовать в фактах. Верни JSON "
    '{"answer": "...", "sources": ["log#N tool", "report.md", ...]}.'
)

_HOUR_RE = re.compile(r"\b(\d{1,2}):(\d{2})\b")
_DAY_RE = re.compile(r"\b(\d{1,2})\s*(?:февраля|января|марта|\.0[1-3])")
_NUM_RE = re.compile(r"(?<![\w.])[-+]?\d+(?:[.,]\d+)?")
# digit groups split by a space / thin space / apostrophe ("1 000") must not pass as "1" and "000"
_GROUP_RE = re.compile(r"(?<=\d)[   '](?=\d{3}\b)")
# run_id is used to build file paths: only the safe alphabet, no separators, no ".."
_RUN_ID_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.-]{0,63}")
_TAG_RE = re.compile(r"<[^>]*>")
MAX_ANSWER_CHARS = 1500

_INTENTS: list[tuple[str, tuple[str, ...]]] = [
    ("peak", ("пик", "максим", "больше всего", "самый сильн", "шың", "ең жоғары")),
    ("calm", ("штиль", "миним", "меньше всего", "самый слаб", "тыныш")),
    ("recompute", ("пересч", "ревиз", "обнов", "изменил", "измени", "поменя", "қайта")),
    ("weather", ("погод", "источник", "прогон", "свеж", "утечк", "откуда", "open-meteo", "ауа")),
    (
        "band",
        ("коридор", "довер", "неопредел", "p10", "p90", "интервал", "риск", "верить", "сенім"),
    ),
    ("model", ("модел", "почему", "fallback", "запасн", "провер", "решени", "неге")),
    ("steps", ("шаг", "журнал", "лог", "что делал", "что сделал", "как работал", "қадам")),
    ("energy", ("средн", "сколько", "энерг", "мвт", "завтра", "послезавтра", "сутк", "выработк")),
]


@dataclass
class Facts:
    run_id: str
    steps: list[AgentStep]
    rows: pd.DataFrame  # ForecastRow rows of this run, all revisions, with time_local column
    report: str
    csv_name: str | None
    derived: dict = field(default_factory=dict)

    @property
    def empty(self) -> bool:
        return not self.steps and self.rows.empty


def load_facts(
    run_id: str, runs_dir: Path | None = None, forecasts_dir: Path | None = None
) -> Facts:
    runs_dir = runs_dir or config.RUNS_DIR
    forecasts_dir = forecasts_dir or config.OUTPUTS_FORECASTS
    if not _RUN_ID_RE.fullmatch(run_id) or ".." in run_id:  # never touch paths outside runs/
        return Facts(run_id, [], pd.DataFrame(), "", None)
    steps = RunLog.read(run_id, runs_dir)
    report_path = runs_dir / run_id / "report.md"
    report = report_path.read_text(encoding="utf-8") if report_path.exists() else ""
    rows, csv_name = _rows_for_run(run_id, forecasts_dir)
    facts = Facts(run_id, steps, rows, report, csv_name)
    facts.derived = _derive(facts)
    return facts


def _rows_for_run(run_id: str, forecasts_dir: Path) -> tuple[pd.DataFrame, str | None]:
    """run_id '20260201T0000-xxxx' = t0 local 01.02 00:00 -> issue day 31.01 -> issue_2026-01-31."""
    candidates: list[Path] = []
    m = re.match(r"(\d{4})(\d{2})(\d{2})T", run_id)
    if m:
        day = pd.Timestamp(f"{m[1]}-{m[2]}-{m[3]}") - pd.Timedelta(days=1)
        candidates.append(forecasts_dir / f"issue_{day:%Y-%m-%d}.csv")
    candidates += sorted(p for p in forecasts_dir.glob("issue_*.csv") if p not in candidates)
    for path in candidates:
        if not path.exists():
            continue
        df = pd.read_csv(path)
        if "run_id" not in df or not (df["run_id"] == run_id).any():
            continue
        df = df[df["run_id"] == run_id].copy()
        utc = pd.to_datetime(df["target_time_utc"], utc=True)
        df["time_local"] = utc.dt.tz_convert(config.LOCAL_TZ)
        return df.reset_index(drop=True), path.name
    return pd.DataFrame(), None


def _when(ts) -> str:
    return pd.Timestamp(ts).strftime("%d.%m %H:%M")


def _derive(facts: Facts) -> dict:
    """Numbers the templates quote; they also feed the set of allowed numbers for the LLM check."""
    rows = facts.rows
    if rows.empty:
        return {}
    latest = rows.sort_values(["lead_h", "revision"]).groupby("lead_h").tail(1)
    latest = latest.sort_values("lead_h")
    mw = config.RATED_MW
    d: dict = {"rated_mw": mw, "revisions": int(rows["revision"].max()) + 1}
    for name, day in (
        ("d1", latest[latest["lead_h"] < 24]),
        ("d2", latest[latest["lead_h"] >= 24]),
    ):
        if day.empty:
            continue
        d[name] = {
            "date": _when(day["time_local"].iloc[0])[:5],
            "mean_pct": f"{day['power_farm'].mean():.0%}",
            "mean_mw": f"{day['power_farm'].mean() * mw:.1f}",
            "energy_mwh": f"{day['power_farm'].sum() * mw:.0f}",
        }
    pk, lo = latest.loc[latest["power_farm"].idxmax()], latest.loc[latest["power_farm"].idxmin()]
    d["peak"] = {
        "when": _when(pk["time_local"]),
        "pct": f"{pk['power_farm']:.0%}",
        "mw": f"{pk['power_farm'] * mw:.1f}",
        "ws": f"{pk['ws100_fc']:.1f}",
    }
    d["min"] = {"when": _when(lo["time_local"]), "pct": f"{lo['power_farm']:.0%}"}
    d["calm_hours"] = int((latest["power_farm"] < 0.05).sum())
    width = latest["p90"] - latest["p10"]
    wide = latest.loc[width.idxmax()]
    d["band"] = {
        "mean_pct": f"{width.mean():.0%}",
        "widest_when": _when(wide["time_local"]),
        "widest_pct": f"{(wide['p90'] - wide['p10']):.0%}",
    }
    d["wx_fields"] = {k: int(v) for k, v in latest["wx_field"].value_counts().items()}
    d["wx_model"] = str(latest["wx_model"].iloc[0])
    d["model_name"] = str(latest["model_name"].iloc[0])
    d["fallback_used"] = bool(latest["fallback_used"].any())
    rev1 = rows[rows["revision"] == 1]
    if not rev1.empty:
        rev0 = rows[rows["revision"] == 0].set_index("lead_h")["power_farm"]
        delta = (rev1.set_index("lead_h")["power_farm"] - rev0.reindex(rev1["lead_h"])).abs()
        top = delta.idxmax()
        top_row = rev1[rev1["lead_h"] == top].iloc[0]
        d["recompute"] = {
            "hours": int(len(rev1)),
            "changed_hours": int((delta >= 0.05).sum()),
            "max_delta_pct": f"{delta.max():.0%}",
            "max_when": _when(top_row["time_local"]),
        }
    return d


def _hour_row(facts: Facts, question: str) -> pd.Series | None:
    """The forecast row for an hour named in the question (HH:MM, optionally with a day)."""
    hm = _HOUR_RE.search(question)
    if hm is None or facts.rows.empty:
        return None
    hour = int(hm.group(1))
    rows = facts.rows.sort_values(["lead_h", "revision"]).groupby("lead_h").tail(1)
    hit = rows[rows["time_local"].dt.hour == hour]
    dm = _DAY_RE.search(question)
    if dm is not None:
        hit = hit[hit["time_local"].dt.day == int(dm.group(1))]
    return hit.iloc[0] if not hit.empty else None


def _step(facts: Facts, tool: str) -> AgentStep | None:
    return next((s for s in facts.steps if s.tool == tool), None)


def answer_template(facts: Facts, question: str) -> tuple[str, list[str]]:
    """Rule-based answer from the facts (mode 'demo'); every number comes from derived or a row."""
    q = question.lower()
    d = facts.derived
    parts: list[str] = []
    sources: list[str] = []
    src_csv = facts.csv_name or "issue csv"

    def step_text(tool: str) -> None:
        s = _step(facts, tool)
        if s is not None:
            decision = f" Решение: {s.decision} — {s.reason}." if s.decision else ""
            parts.append(f"{s.summary}{decision}")
            sources.append(f"log#{s.step} {s.tool}")

    row = _hour_row(facts, question)
    if row is not None:
        parts.append(
            f"{_when(row['time_local'])}: прогноз {row['power_farm']:.0%} номинала "
            f"({row['power_farm'] * config.RATED_MW:.1f} МВт), "
            f"коридор {row['p10']:.0%}–{row['p90']:.0%}, "
            f"ветер {row['ws100_fc']:.1f} м/с, прогон {row['wx_field']} ({row['wx_model']}), "
            f"ревизия {int(row['revision'])}."
        )
        sources.append(f"{src_csv} lead {int(row['lead_h'])}")
    matched = [name for name, keys in _INTENTS if any(k in q for k in keys)]
    for name in matched[:2]:
        if name == "peak" and "peak" in d:
            p = d["peak"]
            parts.append(
                f"Пик: {p['when']} — {p['pct']} номинала ({p['mw']} МВт) при ветре {p['ws']} м/с."
            )
            sources.append(src_csv)
        elif name == "calm" and "min" in d:
            parts.append(
                f"Минимум: {d['min']['when']} — {d['min']['pct']} номинала; часов штиля (< 5 %): "
                f"{d['calm_hours']}."
            )
            sources.append(src_csv)
        elif name == "energy" and "d1" in d:
            for key, label in (("d1", "Сутки 1"), ("d2", "Сутки 2")):
                if key in d:
                    x = d[key]
                    parts.append(
                        f"{label} ({x['date']}): в среднем {x['mean_pct']} номинала "
                        f"({x['mean_mw']} МВт), энергия {x['energy_mwh']} МВт·ч."
                    )
            sources.append(src_csv)
        elif name == "band" and "band" in d:
            b = d["band"]
            parts.append(
                f"Коридор p10–p90 в среднем {b['mean_pct']} номинала, самый широкий "
                f"{b['widest_when']} ({b['widest_pct']}); модель {d['model_name']}, "
                f"запасной вариант {'использован' if d['fallback_used'] else 'не понадобился'}."
            )
            sources.append(src_csv)
            step_text("analyze")
        elif name == "weather":
            step_text("fetch_weather")
            step_text("validate_weather")
            if "wx_fields" in d:
                fields = ", ".join(f"{k}×{v}" for k, v in sorted(d["wx_fields"].items()))
                parts.append(
                    f"Погода: {d['wx_model']}; консервативное правило доступности "
                    f"day1/day2/day3: {fields}. Фактическое время публикации каждого "
                    "исторического прогона этим правилом не подтверждается."
                )
        elif name == "recompute":
            step_text("recompute_if_updated")
            if "recompute" in d:
                r = d["recompute"]
                parts.append(
                    f"Пересчитано часов: {r['hours']}, из них заметно (≥ 5 %): "
                    f"{r['changed_hours']}; "
                    f"наибольшее изменение {r['max_delta_pct']} — {r['max_when']}."
                )
                sources.append(f"{src_csv} rev1")
        elif name == "model":
            step_text("run_model")
            step_text("analyze")
        elif name == "steps":
            for s in facts.steps:
                parts.append(
                    f"{s.step}. {s.tool}: {s.summary}" + (f" → {s.decision}" if s.decision else "")
                )
                sources.append(f"log#{s.step} {s.tool}")
    if not parts:
        lines = [ln.lstrip("- ").strip() for ln in facts.report.splitlines() if ln.strip()]
        parts.append(" ".join(lines[:4]) if lines else "По этому выпуску есть только журнал шагов.")
        parts.append(
            "Можно спросить: пик, штиль, энергия за сутки, конкретный час (ЧЧ:ММ), коридор, "
            "погода и утечка, пересчёт, модель, шаги агента."
        )
        if facts.report:
            sources.append("report.md")
    return _scenario_units(" ".join(parts), facts), list(dict.fromkeys(sources))


def _scenario_units(text: str, facts: Facts) -> str:
    """SCADA power is normalized; MW conversion is a scenario, not a measured nameplate."""
    if "МВт" in text and not facts.rows.empty and "сценарн" not in text.lower():
        text += (
            f" МВт и МВт·ч рассчитаны при сценарном номинале {config.RATED_MW:g} МВт; "
            "паспортная мощность станции в исходных данных не указана."
        )
    return text


# --- grounding: every number in a text must exist in the facts ----------------------------------
def _norm(num: str) -> str:
    """Canonical spelling: '0,24' -> '0.24', '6.30' -> '6.3', '00' -> '0', '+5' -> '5'."""
    s = num.replace(",", ".").lstrip("+")
    sign = "-" if s.startswith("-") else ""
    whole, _, frac = s.lstrip("-").partition(".")
    whole = whole.lstrip("0") or "0"
    frac = frac.rstrip("0")
    value = f"{whole}.{frac}" if frac else whole
    return value if value == "0" else sign + value


def numbers_in(text: str) -> set[str]:
    return {_norm(m) for m in _NUM_RE.findall(_GROUP_RE.sub("", text))}


def allowed_numbers(facts: Facts) -> set[str]:
    allowed: set[str] = set()
    for text in [facts.run_id, facts.report, json.dumps(facts.derived, ensure_ascii=False)]:
        allowed |= numbers_in(text)
    for s in facts.steps:
        allowed |= numbers_in(" ".join(filter(None, [s.summary, s.decision, s.reason])))
    rows = facts.rows
    if not rows.empty:
        for col in ("power_t1", "power_t2", "power_farm", "p10", "p90", "ws100_fc"):
            for v in rows[col].dropna():
                allowed |= {
                    _norm(f"{v:.2f}"),
                    _norm(f"{v:.1f}"),
                    f"{v:.0%}".rstrip("%"),
                    _norm(f"{v * config.RATED_MW:.1f}"),
                }
        allowed |= {str(int(v)) for v in rows["lead_h"]} | {str(int(v)) for v in rows["revision"]}
        allowed |= {str(t.hour) for t in rows["time_local"]} | {
            str(t.day) for t in rows["time_local"]
        }
        allowed |= {f"{t.hour:02d}" for t in rows["time_local"]} | {
            f"{t.day:02d}" for t in rows["time_local"]
        }
        allowed |= {f"{t.month:02d}" for t in rows["time_local"]} | {
            str(t.year) for t in rows["time_local"]
        }
    return allowed


def is_grounded(text: str, facts: Facts) -> tuple[bool, str | None]:
    allowed = allowed_numbers(facts)
    for num in sorted(numbers_in(text)):
        if num not in allowed:
            return False, f"ungrounded number: {num}"
    return True, None


# --- entry point ---------------------------------------------------------------------------------
class _LlmReply(BaseModel):
    answer: str
    sources: list[str] = []


def _user_prompt(facts: Facts, question: str) -> str:
    latest = facts.rows.sort_values(["lead_h", "revision"]).groupby("lead_h").tail(1)
    table = [
        {
            "time_local": _when(r["time_local"]),
            "lead_h": int(r["lead_h"]),
            "revision": int(r["revision"]),
            "power_farm": round(float(r["power_farm"]), 2),
            "p10": round(float(r["p10"]), 2),
            "p90": round(float(r["p90"]), 2),
            "ws100_fc": round(float(r["ws100_fc"]), 1),
            "wx_field": r["wx_field"],
        }
        for _, r in latest.sort_values("lead_h").iterrows()
    ]
    steps = [
        {
            "step": s.step,
            "tool": s.tool,
            "status": s.status,
            "summary": s.summary,
            "decision": s.decision,
            "reason": s.reason,
        }
        for s in facts.steps
    ]
    pack = {
        "run_id": facts.run_id,
        "report": facts.report,
        "derived": facts.derived,
        "steps": steps,
        "hourly": table,
        "allowed_sources": sorted(allowed_sources(facts)),
    }
    return f"Вопрос: {question}\n\nФакты выпуска (JSON):\n{json.dumps(pack, ensure_ascii=False)}"


def answer(run_id: str, question: str) -> AskAnswer:
    """Answer a dispatcher's question about one issue from its facts; LLM trouble never raises.

    grounded is computed for every answer, the template's too: it says whether each number in the
    text exists in the facts. A run with a log but no forecast rows is explicitly unavailable;
    neither a stale report nor an LLM may invent its missing forecast.
    """
    facts = load_facts(run_id)
    if facts.empty:
        return AskAnswer(
            answer=f"Выпуск {run_id} не найден: нет ни журнала агента, ни строк прогноза.",
            mode="demo",
            grounded=True,
            sources=[],
        )
    if facts.rows.empty:
        text = (
            "По этому выпуску строк прогноза нет: актуальный issue CSV не найден. "
            "Численные выводы из старого отчёта не подтверждены; "
            "выберите выпуск с сохранённым прогнозом или выполните пересчёт."
        )
        grounded, _ = is_grounded(text, facts)
        return AskAnswer(
            answer=text,
            mode="demo",
            grounded=grounded,
            sources=[],
            fallback_reason="forecast rows unavailable",
        )
    text, sources = answer_template(facts, question)
    grounded, why = is_grounded(text, facts)
    template = AskAnswer(
        answer=text,
        mode="demo",
        grounded=grounded,
        sources=sources,
        fallback_reason=None if grounded else why,
    )
    if llm.llm_mode() == "demo":
        return template
    try:
        reply = llm.complete_json(_LlmReply, SYSTEM_PROMPT, _user_prompt(facts, question))
    except Exception:  # the LLM path must never break the answer
        reply = None
    if reply is None:
        return template.model_copy(update={"fallback_reason": "llm unavailable"})
    # plain text only: the page must never render markup that came out of a model
    clean = _TAG_RE.sub("", reply.answer).strip()[:MAX_ANSWER_CHARS]
    if not clean:
        return template.model_copy(update={"fallback_reason": "empty answer"})
    clean = _scenario_units(clean, facts)
    ok, why = is_grounded(clean, facts)
    if not ok:
        return template.model_copy(update={"fallback_reason": why})
    known = allowed_sources(facts)
    cited = [s for s in reply.sources if s in known]  # an LLM may cite what does not exist
    if reply.sources and not cited:
        return template.model_copy(update={"fallback_reason": "unsupported llm sources"})
    merged = list(dict.fromkeys([*cited, *sources]))
    return AskAnswer(answer=clean, mode="llm", grounded=True, sources=merged)


def allowed_sources(facts: Facts) -> set[str]:
    """Source labels that name real facts of this run; anything else from the LLM is dropped."""
    known = {f"log#{s.step} {s.tool}" for s in facts.steps}
    if facts.report:
        known.add("report.md")
    if facts.csv_name and not facts.rows.empty:
        known.add(facts.csv_name)
        known |= {f"{facts.csv_name} rev{int(v)}" for v in facts.rows["revision"]}
        known |= {f"{facts.csv_name} lead {int(v)}" for v in facts.rows["lead_h"]}
    return known

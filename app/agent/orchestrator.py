"""Deterministic agent loop (default, no keys), docs/SOLUTION.md section 8:

plan -> fetch_weather -> validate_weather [-> older run / gfs fallback] -> prepare -> run_model
-> analyze [-> self-correct: power_curve -> climatology] -> recompute_if_updated (t0 + 12 h)
-> reflect -> write_report. Every step is a JSONL line with the decision and its reason.
"""

import hashlib
import json
import re
import shutil
import time
from datetime import date, timedelta

import numpy as np
import pandas as pd

from app import config
from app.agent import tools
from app.agent.log import RunLog
from app.features import issue_time_utc
from app.schemas import FORECAST_COLUMNS, ForecastIssue, ForecastRow, LlmInfo

MONTHS = [
    "января",
    "февраля",
    "марта",
    "апреля",
    "мая",
    "июня",
    "июля",
    "августа",
    "сентября",
    "октября",
    "ноября",
    "декабря",
]
FALLBACK_LADDER = ["gbm", "power_curve", "climatology"]
MODEL_TITLES = {
    "gbm": "градиентный бустинг (медиана) с калиброванным коридором p10–p90",
    "power_curve": "кривая мощности по прогнозному ветру (запасная модель)",
    "climatology": "климатология месяц × час (крайний запасной вариант)",
}


def _local(ts) -> pd.Timestamp:
    return pd.Timestamp(ts).tz_convert(config.LOCAL_TZ)


def _day(ts) -> str:
    t = _local(ts)
    return f"{t.day} {MONTHS[t.month - 1]}"


def _when(ts) -> str:
    t = _local(ts)
    return f"{t.day} {MONTHS[t.month - 1]}, {t:%H:%M}"


def _run_id(issue_date: date, t0: pd.Timestamp) -> str:
    meta = config.WEATHER_CACHE / "meta.json"
    seed = f"{issue_date}|{tools.model().meta.get('created_at')}|"
    seed += meta.read_text(encoding="utf-8") if meta.exists() else ""
    return f"{_local(t0):%Y%m%dT%H%M}-{hashlib.sha256(seed.encode()).hexdigest()[:6]}"


def _rows(pred, sel, t0, revision, model_name, wx_model, fallback, run_id) -> list[dict]:
    rows = []
    for i in range(len(pred)):
        target = pd.Timestamp(pred["target"].iloc[i])
        lead = int(pred["lead"].iloc[i])
        rows.append(
            ForecastRow(
                issue_time_utc=t0,
                issue_time_local=_local(t0),
                target_time_utc=target,
                target_time_local=_local(target),
                lead_h=lead,
                horizon="24h" if lead < 24 else "48h",
                revision=revision,
                power_t1=round(float(pred["power_t1"].iloc[i]), 4),
                power_t2=round(float(pred["power_t2"].iloc[i]), 4),
                power_farm=round(float(pred["power_farm"].iloc[i]), 4),
                p10=round(float(pred["p10"].iloc[i]), 4),
                p90=round(float(pred["p90"].iloc[i]), 4),
                ws100_fc=round(float(sel["ws100"].iloc[i]), 2),
                wx_field=f"day{int(sel['field'].iloc[i])}" if sel["field"].iloc[i] > 0 else "none",
                wx_model=wx_model,
                model_name=model_name,
                fallback_used=fallback,
                run_id=run_id,
            ).model_dump(mode="json")
        )
    return rows


def _forecast_with_ladder(log: RunLog, sel, gfs_sel, start_model: str, offset: float):
    """Run the model; on a failed check step down the ladder (at most 2 corrections)."""
    ladder = FALLBACK_LADDER[FALLBACK_LADDER.index(start_model) :]
    for attempt, name in enumerate(ladder):
        s = time.perf_counter()
        pred = tools.run_model(sel, name)
        log.step(
            "run_model",
            "ok",
            f"Модель «{name}»: среднее по станции "
            f"{pred['power_farm'].mean():.0%}, максимум {pred['power_farm'].max():.0%}",
            args={"model_name": name},
            started=s,
        )
        s = time.perf_counter()
        check = tools.analyze(pred, sel, gfs_sel, offset)
        failed = [k for k, v in check["checks"].items() if not v]
        if check["ok"] or attempt == len(ladder) - 1:
            log.step(
                "analyze",
                "ok" if check["ok"] else "warn",
                f"Проверки: {'не пройдено: ' + ', '.join(failed) if failed else 'все пройдены'}; "
                f"расхождение с кривой мощности {check['gap_to_power_curve']:.2f}",
                args={"checks": check["checks"], "risks": check["risks"]},
                started=s,
                decision="accept",
                reason="прогноз согласован с физикой и диапазонами"
                if check["ok"]
                else "последняя ступень, публикуем с предупреждением",
            )
            return pred, name, attempt > 0, check
        log.step(
            "analyze",
            "warn",
            f"Не пройдено: {', '.join(failed)}",
            started=s,
            args={"checks": check["checks"]},
            decision=f"fallback → {ladder[attempt + 1]}",
            reason="самокоррекция: переходим на более простую и устойчивую модель",
        )
    raise RuntimeError("unreachable")


def _previous_issue_delta(issue_date: date, pred: pd.DataFrame, out_dir) -> dict | None:
    prev = out_dir / f"issue_{(issue_date - timedelta(days=1)).isoformat()}.csv"
    if not prev.exists():
        return None
    p = pd.read_csv(prev)
    p = p[p["revision"] == p["revision"].max()]
    p["target"] = pd.to_datetime(p["target_time_utc"], utc=True)
    cur = pred[["target", "power_farm"]].merge(
        p[["target", "power_farm"]], on="target", suffixes=("", "_prev")
    )
    if cur.empty:
        return None
    d = (cur["power_farm"] - cur["power_farm_prev"]).abs()
    return {
        "hours": len(cur),
        "mean_abs_delta": round(float(d.mean()), 3),
        "max_abs_delta": round(float(d.max()), 3),
    }


def _summary(issue_date, t0, rows0, rows1, check, recompute, reflect, prev, val, model_name):
    latest = pd.DataFrame(rows0)
    if rows1:
        r1 = pd.DataFrame(rows1)
        latest = pd.concat([latest[latest["lead_h"] < r1["lead_h"].min()], r1], ignore_index=True)
    latest["target"] = pd.to_datetime(latest["target_time_utc"], utc=True)
    d1, d2 = latest[latest["lead_h"] < 24], latest[latest["lead_h"] >= 24]
    pk = latest.loc[latest["power_farm"].idxmax()]
    mw = config.RATED_MW
    lines = [
        f"Выпуск за {_day(pd.Timestamp(issue_date, tz=config.LOCAL_TZ))}: прогноз сделан "
        f"{_when(t0)} по Алматы по итогам дня, горизонт 48 ч.",
        "",
        f"- {_day(d1['target'].iloc[0]).capitalize()}: средняя выработка "
        f"{d1.power_farm.mean():.0%} номинала ({d1.power_farm.mean() * mw:.1f} МВт), "
        f"энергия {d1.power_farm.sum() * mw:.0f} МВт·ч.",
        f"- {_day(d2['target'].iloc[0]).capitalize()} (черновик суточной заявки, подать до 08:00 "
        f"{_day(d1['target'].iloc[0])}): средняя {d2.power_farm.mean():.0%} "
        f"({d2.power_farm.mean() * mw:.1f} МВт), энергия {d2.power_farm.sum() * mw:.0f} МВт·ч.",
        f"- Пик: {_when(pk.target)} — {pk.power_farm:.0%} ({pk.power_farm * mw:.1f} МВт) "
        f"при прогнозном ветре {pk.ws100_fc:.1f} м/с.",
        f"- Коридор p10–p90 в среднем {(latest.p90 - latest.p10).mean():.0%} номинала.",
    ]
    r = check["risks"]
    risk = []
    if r["ramp_hours"]:
        risk.append(f"резкие изменения мощности около {', '.join(r['ramp_hours'][:3])}")
    if r["calm_hours"]:
        risk.append(f"штиль {r['calm_hours']} ч")
    if r["cold_risk_hours"]:
        risk.append(f"холодовой риск недовыработки {r['cold_risk_hours']} ч")
    if r.get("nwp_disagree_hours"):
        risk.append(f"погодные модели расходятся {r['nwp_disagree_hours']} ч")
    lines.append("- Риски: " + ("; ".join(risk) if risk else "существенных нет") + ".")
    lines.append(
        f"- Погода: Open-Meteo, источник {val['source']}, свежесть прогонов: "
        + ", ".join(f"{k}×{v}" for k, v in sorted(val["fields"].items()))
        + "."
    )
    if recompute["recomputed"]:
        t1 = _local(t0 + pd.Timedelta(hours=config.INTRADAY_REFRESH_H))
        lines.append(
            f"- Пересчёт {_day(t1)} в {t1:%H:%M}: "
            f"вышел более свежий прогон для {recompute['changed_hours']} ч; "
            f"наибольшее изменение {recompute['max_delta']:.0%} — {recompute['max_at']}."
        )
    if prev:
        lines.append(
            f"- По сравнению с прошлым выпуском на общих {prev['hours']} ч прогноз "
            f"сдвинулся в среднем на {prev['mean_abs_delta']:.0%}."
        )
    if reflect.get("mae") is not None:
        lines.append(
            f"- Самопроверка по своим прошлым выпускам ({reflect['days']} дн.): ошибка "
            f"{reflect['mae']:.0%}, смещение {reflect['bias']:+.0%}; "
            + (
                "есть признак дрейфа, рекомендуется переобучение."
                if reflect["drift"]
                else "дрейфа нет."
            )
        )
    elif reflect.get("frozen"):
        lines.append(
            f"- Самопроверка: факт известен только до {reflect['facts_until']}, "
            "для опубликованных выпусков его ещё нет — прогноз не корректируется."
        )
    lines.append(
        f"- Модель: {MODEL_TITLES.get(model_name, model_name)}; точечный прогноз — "
        "медиана, это оптимальная заявка при симметричных коэффициентах "
        "балансирующего рынка."
    )
    return "\n".join(lines)


def _llm_summary(facts_text: str, template: str) -> tuple[str, LlmInfo | None, str]:
    """Optional: the LLM rewrites the summary; every number must already exist in the facts."""
    from pydantic import BaseModel

    from app.llm import complete_json, llm_mode

    if llm_mode() != "llm":
        return template, None, "нет ключа LLM — шаблонная сводка"

    class Summary(BaseModel):
        summary: str

    system = (
        "Ты — помощник диспетчера ВЭС. Перепиши сводку прогноза короче и понятнее по-русски, "
        "3–6 пунктов. Используй только числа из фактов, не придумывай новые. "
        'Верни JSON {"summary": "..."}'
    )
    res = complete_json(Summary, system, facts_text)
    if res is None:
        return template, None, "LLM не ответил — шаблонная сводка"
    allowed = set(re.findall(r"\d+(?:[.,]\d+)?", facts_text))
    extra = [n for n in re.findall(r"\d+(?:[.,]\d+)?", res.summary) if n not in allowed]
    from app.llm import last_provider

    used = last_provider()
    info = LlmInfo(
        provider=used.get("provider", ""), model=used.get("model", ""), tokens=used.get("tokens", 0)
    )
    if extra:
        return template, info, f"llm_rejected: числа не из фактов ({', '.join(extra[:3])})"
    return res.summary, info, "сводка LLM прошла проверку чисел"


def run_issue(
    issue_date: date,
    *,
    refresh: bool = False,
    model_name: str = "gbm",
    llm: bool = False,
    out_dir=config.OUTPUTS_FORECASTS,
    runs_dir=config.RUNS_DIR,
) -> ForecastIssue:
    t_all = time.perf_counter()
    t0 = issue_time_utc(issue_date)
    run_id = _run_id(issue_date, t0)
    shutil.rmtree(runs_dir / run_id, ignore_errors=True)
    log = RunLog(run_id, t0.to_pydatetime(), base_dir=runs_dir)

    f = tools.facts()
    facts_end = f["p"].last_valid_index() + pd.Timedelta(hours=1)
    frozen = facts_end < t0
    log.step(
        "plan",
        "ok",
        f"Выпуск за {_day(pd.Timestamp(issue_date, tz=config.LOCAL_TZ))}: момент прогноза "
        f"{_when(t0)} (Алматы), горизонт 48 ч, модель «{model_name}»",
        args={
            "issue_date": issue_date.isoformat(),
            "t0_utc": t0.isoformat(),
            "model_name": model_name,
            "refresh": refresh,
        },
        decision="facts_frozen" if frozen else "facts_complete",
        reason=(
            f"факт известен до {_when(facts_end - pd.Timedelta(hours=1))}: "
            "прогноз строится только на погоде"
        )
        if frozen
        else "факт известен до момента прогноза",
    )

    s = time.perf_counter()
    wx = tools.fetch_weather("best_match", refresh)
    wg = tools.fetch_weather("gfs_seamless", refresh)
    log.step(
        "fetch_weather",
        "ok",
        f"Open-Meteo Previous Runs по координатам ВЭС: best_match и gfs_seamless, "
        f"{len(wx)} ч архива",
        args={"models": ["best_match", "gfs_seamless"], "refresh": refresh},
        started=s,
        decision="live" if refresh else "cache",
        reason="живой запрос к API"
        if refresh
        else "офлайн-кэш из репозитория (тот же ответ API, sha256 в meta.json)",
    )

    s = time.perf_counter()
    sel = tools.select_weather(wx, t0)
    gsel = tools.select_weather(wg, t0)
    val = tools.validate_weather(sel, t0)
    shift = tools.source_shift(wx, t0)
    offset = tools.nwp_offset(wx, wg, t0)
    wx_model, use_model = "best_match", model_name
    if not val["ok"]:
        gval = tools.validate_weather(gsel, t0)
        if gval["ok"]:
            sel, val, wx_model, use_model = gsel, gval, "gfs_seamless", "gfs_power_curve"
            decision, reason = "switch → gfs_seamless", "основной источник не прошёл проверку"
        else:
            use_model = "climatology"
            decision, reason = "climatology", "ни один источник погоды не прошёл проверку"
    else:
        decision, reason = (
            "proceed",
            "каждый час взят из прогона, опубликованного до момента прогноза",
        )
    log.step(
        "validate_weather",
        "ok" if val["ok"] else "warn",
        f"Покрыто {val['covered']}/{val['hours']} ч, "
        f"диапазон {'ок' if val['in_range'] else 'нарушен'}, "
        f"допустимость прогонов {'ок' if val['admissible'] else 'НАРУШЕНА'}; свежесть: "
        + ", ".join(f"{k}×{v}" for k, v in sorted(val["fields"].items()))
        + f"; источник best_match — {val['source']}; средний ветер за 30 дней "
        f"{shift['recent_mean_ws']} м/с против {shift['train_mean_ws']} в обучении",
        args={**val, **shift},
        started=s,
        decision=decision,
        reason=reason,
    )

    s = time.perf_counter()
    pers = tools.persistence_level(t0)
    log.step(
        "prepare",
        "ok",
        f"Признаки 48 ч (ветер 100/10 м, порывы, направление, температура, час, опережение, "
        f"эпоха источника); персистентность {pers:.0%}"
        if np.isfinite(pers)
        else "Признаки 48 ч; наблюдений за последние 24 ч нет — персистентность недоступна",
        args={"persistence": None if not np.isfinite(pers) else round(pers, 3)},
        started=s,
    )

    start = use_model if use_model in FALLBACK_LADDER else "gbm"
    if use_model == "gfs_power_curve":
        pred = tools.run_model(sel, "gfs_power_curve")
        check = tools.analyze(pred, sel, None, offset)
        used, fallback = "power_curve", True
        log.step(
            "run_model",
            "warn",
            "Кривая мощности по gfs_seamless (запасной источник)",
            args={"model_name": "gfs_power_curve"},
            decision="fallback",
            reason="основной источник погоды недоступен",
        )
    else:
        pred, used, fallback, check = _forecast_with_ladder(log, sel, gsel, start, offset)
    rows0 = _rows(pred, sel, t0, 0, used, wx_model, fallback, run_id)

    s = time.perf_counter()
    rows1, recompute = [], {"recomputed": False}
    t1 = t0 + pd.Timedelta(hours=config.INTRADAY_REFRESH_H)
    sel1 = tools.select_weather(
        wx if wx_model == "best_match" else wg, t0, config.INTRADAY_REFRESH_H
    )
    later = sel1["lead"] >= config.CORRECTION_MIN_LEAD_H
    changed = int((sel1.loc[later, "field"] != sel.loc[later, "field"]).sum())
    if changed and used != "climatology":
        val1 = tools.validate_weather(sel1, t0, config.INTRADAY_REFRESH_H)
        pred1 = tools.run_model(sel1, used if wx_model == "best_match" else "gfs_power_curve")
        keep = later.to_numpy()
        pred1, s1 = pred1[keep].reset_index(drop=True), sel1[keep].reset_index(drop=True)
        delta = np.abs(pred1["power_farm"].to_numpy() - pred["power_farm"].to_numpy()[keep])
        i = int(delta.argmax())
        material = (
            delta.mean() > config.MATERIAL_MEAN_DELTA or delta.max() > config.MATERIAL_MAX_DELTA
        )
        rows1 = _rows(pred1, s1, t0, 1, used, wx_model, fallback, run_id)
        recompute = {
            "recomputed": True,
            "changed_hours": changed,
            "mean_delta": round(float(delta.mean()), 3),
            "max_delta": round(float(delta.max()), 3),
            "max_at": _when(pred1["target"].iloc[i]),
            "material": bool(material),
            "admissible": val1["admissible"],
        }
        log.step(
            "recompute_if_updated",
            "ok",
            f"В {_when(t1)} для {changed} из {int(later.sum())} часов (не раньше чем за 2 ч "
            f"до часа) доступен более свежий прогон → ревизия 1; средний сдвиг "
            f"{delta.mean():.0%}, наибольший {delta.max():.0%} — {_when(pred1['target'].iloc[i])}",
            args={"hours_since_issue": config.INTRADAY_REFRESH_H, **recompute},
            started=s,
            decision="recompute"
            + (" (существенно)" if material else " (без существенных изменений)"),
            reason="входные данные обновились: для части часов вышел более свежий прогон погоды",
        )
    else:
        log.step(
            "recompute_if_updated",
            "ok",
            f"В {_when(t1)} новых допустимых прогонов нет",
            args={"hours_since_issue": config.INTRADAY_REFRESH_H},
            started=s,
            decision="no_update",
            reason="поле погоды ни у одного часа не изменилось",
        )

    s = time.perf_counter()
    ref = tools.reflect(t0, out_dir)
    log.step(
        "reflect",
        "warn" if ref.get("drift") else "ok",
        (
            f"Свои выпуски за {ref['days']} дн. против факта: ошибка {ref['mae']:.0%}, "
            f"смещение {ref['bias']:+.0%}, t = {ref['t_stat']}"
        )
        if ref.get("mae") is not None
        else f"Факт известен до {ref['facts_until']}: для прошлых выпусков агента "
        "его ещё нет, самопроверка по ошибкам недоступна",
        args=ref,
        started=s,
        decision="drift: рекомендовано переобучение"
        if ref.get("drift")
        else ("frozen" if ref.get("frozen") else "ok"),
        reason=(
            "в тестовом периоде новых наблюдений нет: прогноз не корректируется "
            "молча, рефлексия включится, когда придёт факт"
        )
        if ref.get("frozen")
        else (
            "смещение значимо: предлагаем переобучение, модель сами не меняем"
            if ref.get("drift")
            else "смещение статистически незначимо"
        ),
    )

    s = time.perf_counter()
    prev = _previous_issue_delta(issue_date, pred, out_dir)
    template = _summary(issue_date, t0, rows0, rows1, check, recompute, ref, prev, val, used)
    summary, llm_info, llm_note = template, None, None
    if llm:
        facts_json = json.dumps({"summary": template, "risks": check["risks"]}, ensure_ascii=False)
        summary, llm_info, llm_note = _llm_summary(facts_json, template)
    out_dir.mkdir(parents=True, exist_ok=True)
    path = out_dir / f"issue_{issue_date.isoformat()}.csv"
    pd.DataFrame(rows0 + rows1, columns=FORECAST_COLUMNS).to_csv(path, index=False)
    (log.dir / "report.md").write_text(summary + "\n", encoding="utf-8")
    log.step(
        "write_report",
        "ok",
        f"Сохранено: {path.name} ({len(rows0)} + {len(rows1)} строк), сводка report.md",
        started=t_all,
        llm=llm_info,
        decision="llm" if llm_info else "template",
        reason=llm_note or "шаблонная сводка по фактам выпуска",
    )
    return ForecastIssue(
        issue_date=issue_date,
        issue_time_utc=t0.to_pydatetime(),
        run_id=run_id,
        model_name=used,
        revision=1 if rows1 else 0,
        fallback_used=fallback,
        rows=[ForecastRow.model_validate(r) for r in rows0 + rows1],
        summary=summary,
        warnings=[f"{s.tool}: {s.reason or s.summary}" for s in log.steps if s.status != "ok"],
    )

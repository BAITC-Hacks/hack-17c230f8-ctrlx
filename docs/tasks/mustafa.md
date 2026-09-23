# mustafa — задачи

<!-- Меняет только mustafa (или его агент). Остальные читают: scripts/sync.sh показывает «Сейчас» и «Нужно от других» у всех. -->

## Сейчас
- R5 — `app/agent/orchestrator.py`: детерминированный цикл plan → fetch_weather → validate_weather → prepare → run_model → analyze → [self-correct: fallback на power_curve, макс. 2 попытки] → recompute_if_updated (t0 + 12 ч, rev1) → write_report; `app/agent/tools.py` — реализации поверх `app.weather` / `app.data` / `app.models`, до их появления — моки на кэше и кривой мощности. · Готово, когда: `forecast --issue 2026-01-31` пишет `outputs/forecasts/issue_2026-01-31.csv` (48 строк) и `runs/<id>/agent_log.jsonl` с решениями.

## Дальше
- R4 — `backtest` на 28 выпусков + `february_2026.csv`; тест на утечку по колонке `wx_field`.
- R9 — `app/agent/llm_planner.py`: function calling на `TOOL_SPECS`, аналитик-сводка RU; прогон с ключом → `runs/llm_demo/`.
- R10 — валидация переключает `best_match` ↔ `gfs_seamless`, разброс в p10/p90 и в лог.
- После 16:30: `/critics`, чистый clone, деплой по желанию.

## Нужно от других
- amirkhan: `app.data.build_hourly`, `app.models.predict`, `app.train`.
- ansar: `app.weather.load_or_fetch`, `select_for_issue`.

## Готово
- kickoff: ТЗ, каркас py, зависимости (sklearn, lightgbm, pyarrow), данные и кэш погоды в репо, контракт `app/schemas.py` + `app/config.py`, зоны, задачи.

# mustafa — задачи

<!-- Меняет только mustafa (или его агент). Остальные читают: scripts/sync.sh показывает «Сейчас» и «Нужно от других» у всех. -->

## Сейчас
- R1 — `app/data.py`: `build_hourly()` → `data/processed/hourly.parquet` (tz Asia/Almaty → UTC, ≥4 из 6 точек, флаги). Готово, когда parquet ~25 000 ч × 2.
- R3 — `app/models.py` power_curve (MOS на прогнозном ws100, квантили по бинам) + `app/train.py`; `app/store.py` — SQLite-индекс выпусков и прогонов (`data/processed/windcast.sqlite`) для API.
- R5 — `app/agent/orchestrator.py`: детерминированный цикл plan → fetch_weather → validate_weather → prepare → run_model → analyze → [self-correct: fallback на power_curve, макс. 2 попытки] → recompute_if_updated (t0 + 12 ч, rev1) → write_report; `app/agent/tools.py` — реализации поверх `app.weather` / `app.data` / `app.models`, до их появления — моки на кэше и кривой мощности. · Готово, когда: `forecast --issue 2026-01-31` пишет `outputs/forecasts/issue_2026-01-31.csv` (48 строк) и `runs/<id>/agent_log.jsonl` с решениями.

## Дальше
- R4 — `backtest` на 28 выпусков + `february_2026.csv`; тест на утечку по колонке `wx_field`.
- R9 — `app/agent/llm_planner.py`: function calling на `TOOL_SPECS`, аналитик-сводка RU; прогон с ключом → `runs/llm_demo/`.
- R10 — валидация переключает `best_match` ↔ `gfs_seamless`, разброс в p10/p90 и в лог.
- После 16:30: `/critics`, чистый clone, деплой по желанию.

## Нужно от других
- amirkhan: `app.weather.load_or_fetch`, `select_for_issue` (R2), кэш с day3.
- ansar: `app/api/routes.py` на образце, страница.

## Готово
- 14:35 образец выпуска для платформы: `outputs/forecasts/issue_2026-01-31.csv`, `runs/20260201T0000-sample/`.
- kickoff: ТЗ, каркас py, зависимости (sklearn, lightgbm, pyarrow), данные и кэш погоды в репо, контракт `app/schemas.py` + `app/config.py`, зоны, задачи.

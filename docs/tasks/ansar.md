# ansar — задачи

<!-- Меняет только ansar (или его агент). Остальные читают: scripts/sync.sh показывает «Сейчас» и «Нужно от других» у всех. -->

## Сейчас
- R2 — `app/weather.py`: `fetch_previous_runs(model, start, end) -> dict` (Open-Meteo Previous Runs, `config.WEATHER_API`, координаты `config.FARM_LAT/LON`, `wind_speed_unit=ms`, `timezone=GMT`, hourly: `wind_speed_100m_previous_day1..3, wind_speed_10m_previous_day1..3, wind_direction_100m_previous_day2, temperature_2m_previous_day2, wind_gusts_10m_previous_day2`, диапазон 2024-02-15…2026-02-28, один запрос ~1 МБ), сохранить в `data/weather_cache/prev_runs_<model>.json` + `meta.json` (url, fetched_at, sha256) для `best_match` и `gfs_seamless`; `load_or_fetch(model="best_match", refresh=False) -> DataFrame[WEATHER_COLUMNS]` (кэш-first, без сети по умолчанию); `select_for_issue(wx, issue_time_utc, hours_since_issue=0) -> DataFrame[ISSUE_WEATHER_COLUMNS]` на 48 часов, поле по `config.safe_previous_day(lead_h, hours_since_issue)`. · Файлы: `app/weather.py`, `tests/test_weather.py`, `data/weather_cache/` · Не трогать: `app/config.py`, `app/schemas.py` · Готово, когда: `tests/test_weather.py` проверяет (а) для каждой строки `select_for_issue` N ≥ `safe_previous_day(lead)`, (б) 48 строк без NaN для t0 = 2026-02-01 00:00 Almaty из кэша, (в) `load_or_fetch` без сети не падает.

## Дальше
- R8 — `app/api/routes.py`: `GET /issues`, `GET /forecast/{issue_date}`, `GET /metrics`, `GET /runs/{run_id}/log`, `POST /run` по `app/schemas.py`; пока агента нет — читать `outputs/forecasts/*.csv` и `runs/*/agent_log.jsonl` с диска (лид положит пример). `static/index.html`: выбор выпуска, график p50 с полосой p10–p90 и линией power_curve (Chart.js с cdnjs), лента шагов агента, таблица метрик; скилл `ui-craft`.
- R6 — README по шаблону (быстрый старт 3 команды без ключей, sha256 данных, правило утечки словами, таблица метрик от Амирхана, трассировка R-ID), `docs/TESTING.md`, `scripts/smoke.sh` (SMOKE_PATH → `GET /api/forecast/2026-01-31`), `tests/test_cli.py` на `backtest --from 2026-01-31 --to 2026-01-31`.

## Нужно от других

## Готово

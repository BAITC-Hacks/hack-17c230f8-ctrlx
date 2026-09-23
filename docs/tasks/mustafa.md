# mustafa — задачи

<!-- Меняет только mustafa (или его агент). Остальные читают: scripts/sync.sh показывает «Сейчас» и «Нужно от других» у всех. -->

## Сейчас
- 16:28 Codex в отдельной рабочей копии: R9 native tool supervisor и R1/R3/R7 изоляция CQR готовы; проверка, checkpoint, затем передача Claude на переобучение и регенерацию артефактов. Claude сохраняет владение orchestrator/replay/evaluate и исходной рабочей копией.
- R1 — `app/data.py`: `build_hourly()` → `data/processed/hourly.parquet` (tz Asia/Almaty → UTC, ≥4 из 6 точек, флаги). Готово, когда parquet ~25 000 ч × 2.
- R3 — `app/models.py` power_curve (MOS на прогнозном ws100, квантили по бинам) + `app/train.py`; `app/store.py` — SQLite-индекс выпусков и прогонов (`data/processed/windcast.sqlite`) для API.
- R5 — `app/agent/orchestrator.py`: детерминированный цикл plan → fetch_weather → validate_weather → prepare → run_model → analyze → [self-correct: fallback на power_curve, макс. 2 попытки] → recompute_if_updated (t0 + 12 ч, rev1) → write_report; `app/agent/tools.py` — реализации поверх `app.weather` / `app.data` / `app.models`, до их появления — моки на кэше и кривой мощности. · Готово, когда: `forecast --issue 2026-01-31` пишет `outputs/forecasts/issue_2026-01-31.csv` (48 строк) и `runs/<id>/agent_log.jsonl` с решениями.

## Дальше
- R4 — `backtest` на 28 выпусков + `february_2026.csv`; тест на утечку по колонке `wx_field`.
- R9 — `app/agent/llm_planner.py`: function calling на `TOOL_SPECS`, аналитик-сводка RU; прогон с ключом → `runs/llm_demo/`.
- R10 — валидация переключает `best_match` ↔ `gfs_seamless`, разброс в p10/p90 и в лог.
- После 16:30: `/critics`, чистый clone, деплой по желанию.

## Нужно от других
- ansar, UI (ревью 15:10, страница на 1280×800 хорошая, правки по важности):
  1. Разрыв полосы p10–p90 на смене свежести погоды (1 февраля 17:00–18:00) — полоса должна быть непрерывной, свежесть показывать заливкой/штриховкой одной полосы.
  2. Пересчёт как главный «вау»: в CSV теперь ревизии 0 (48 ч) и 1 (часы 12–47, пересчёт в t0+12 ч). Показать rev0 пунктиром, rev1 сплошной линией, подпись «пересчитано в 12:00: вышел более свежий прогон».
  3. Шаги агента по-русски крупно («План», «Погода», «Проверка погоды», «Подготовка данных», «Модель», «Анализ», «Пересчёт», «Отчёт»), имя функции мелко рядом.
  4. Под графиком строка источника: «Погода: Open-Meteo Previous Runs (архив прогнозов), каждый час — из прогона, опубликованного до момента прогноза» + счётчик day1/day2/day3.
  5. Иконка сайта (inline SVG data-URI) — сейчас 404 в консоли.
  6. Сводка — простые абзацы/список, markdown-разметку не показывать.
- ansar, тесты: `tests/test_api.py` поправлен лидом под две ревизии (rev0 = 48 строк, rev1 = часы ≥ 12; warnings = шаги warn/fail из лога) — ZONE_OK, чтобы main был зелёным.
- amirkhan: `app.weather.load_or_fetch`, `select_for_issue` (R2), кэш с day3.
- ansar: `app/api/routes.py` на образце, страница.

## Готово
- 16:34 Codex critics: устранены NaN в JSON супервизора, повторный учёт токенов, принятие finish до чтения инструментов, дубликаты tool-call ID; 21 проверка супервизора. Таймауты текстового LLM ограничены, метаданные провайдера изолированы по контексту запроса. REQUIREMENTS синхронизирован с R9 и настоящим источником p10/p90.
- 16:28 Codex: R9 `app/agent/planner.py` выбирает диагностические tools и направляет выпуск в accepted/review под обязательными проверками; CLI `--supervise`; `docs/AGENTIC.md`. R1/R3/R7: метка станции требует обеих турбин, отдельные кривые признаков квантилей и непересекающиеся целевые часы обучения/калибровки. Реальная проверка LLM ожидает локальную настройку ключа, не заявляется выполненной.
- 14:35 образец выпуска для платформы: `outputs/forecasts/issue_2026-01-31.csv`, `runs/20260201T0000-sample/`.
- kickoff: ТЗ, каркас py, зависимости (sklearn, lightgbm, pyarrow), данные и кэш погоды в репо, контракт `app/schemas.py` + `app/config.py`, зоны, задачи.

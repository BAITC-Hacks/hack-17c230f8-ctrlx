# amirkhan — задачи

<!-- Меняет только amirkhan (или его агент). Остальные читают: scripts/sync.sh показывает «Сейчас» и «Нужно от других» у всех. -->

## Сейчас
- R1 — `app/data.py`: `load_raw(turbine_id) -> DataFrame` (разделитель запятая, колонки переименовать в `time, ws, power, temp`; время наивное локальное → `tz_localize("Asia/Almaty", ambiguous/nonexistent="shift_forward")` → UTC), `to_hourly(df) -> DataFrame` (среднее по часу, `n_samples`, NaN при < 4 точек, `flag_gap`), `flag_downtime` (power ≤ 0.01 при ws > 5), `build_hourly() -> data/processed/hourly.parquet` по `HOURLY_COLUMNS` из `app/schemas.py`. Печать допущений (период, доля дыр, доля простоев) в stdout. · Файлы: `app/data.py`, `tests/test_data.py` · Не трогать: `app/schemas.py`, `app/config.py` (просить лида) · Готово, когда: `uv run python -c "from app.data import build_hourly; build_hourly()"` создаёт parquet, ~25 000 часов × 2, тест `to_hourly` на дырах зелёный.

## Дальше
- R3 — `app/models.py`: `Persistence`, `PowerCurve` (бины 0.5 м/с по **прогнозному** ws100 из `select_for_issue`, изотонное сглаживание, отдельно турбина 1/2), общий интерфейс `fit(X, y)` / `predict(X) -> DataFrame[target_time_utc, power_t1, power_t2, p10, p90]`; `app/train.py` — обучение на данных до `config.TRAIN_END` на погоде по правилу `safe_previous_day` (тот же выбор поля, что в тесте) → `models/*.pkl`. Пока `app/weather.py` Ансара не готов — тренируйся на `data/weather_cache/prev_runs_best_match.json` напрямую (поля `wind_speed_100m_previous_day2`, GMT).
- R3 — `gbm`: LightGBM, признаки в `app/features.py` (`build(hourly, wx_issue, issue_time_utc)`): ws100, ws100³, ws10, gust, sin/cos dir, temp2m, 1/(T+273), выход power_curve, sin/cos часа, lead_h; квантили 0.1/0.5/0.9, клип [0,1].
- R7 — `app/evaluate.py`: `main(["--holdout","2026-01"])` → `outputs/metrics/holdout_2026-01.json` (`MetricsReport`), затем февраль 2025; таблица в `docs/METRICS.md`. Ориентир: power_curve на day2 даёт MAE 0,200 на январе 2026, персистентность 0,386.

## Нужно от других

## Готово

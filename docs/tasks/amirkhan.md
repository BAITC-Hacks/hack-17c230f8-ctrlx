# amirkhan — задачи

<!-- Меняет только amirkhan (или его агент). Остальные читают: scripts/sync.sh показывает «Сейчас» и «Нужно от других» у всех. -->

Роль: **идеи и новые функции** + модуль погоды. Идеи — в `docs/IDEAS.md` (таблица: идея · ценность для диспетчера/жюри 1–5 · время · что нужно от других · статус), лиду сообщением `[IDEA]`; делать — только после ОК лида и только в своей зоне. Код: `app/weather.py` — изолированный модуль с тестом, чтобы у тебя были свои коммиты (организаторы смотрят коммиты каждого). Пуш через `scripts/checkpoint.sh` каждые ≤ 30 мин.

## Сейчас
- R2 (к 14:50) — `app/weather.py`: `fetch_previous_runs(model, start, end) -> dict` (Open-Meteo Previous Runs: `config.WEATHER_API`, `latitude/longitude` = `config.FARM_LAT/LON`, `wind_speed_unit=ms`, `timezone=GMT`, `hourly=wind_speed_100m_previous_day1,…day3, wind_speed_10m_previous_day1,…day3, wind_direction_100m_previous_day2, temperature_2m_previous_day2, wind_gusts_10m_previous_day2`, `start_date=2024-02-15`, `end_date=2026-02-28`, `models=<model>`), сохранить сырой JSON в `data/weather_cache/prev_runs_<model>.json` + обновить `meta.json` (url, fetched_at, sha256) для `best_match` и `gfs_seamless`; `load_or_fetch(model="best_match", refresh=False) -> DataFrame[WEATHER_COLUMNS]` (кэш-first; без сети не падает); `select_for_issue(wx, issue_time_utc, hours_since_issue=0) -> DataFrame[ISSUE_WEATHER_COLUMNS]` на 48 часов, поле через `config.safe_previous_day(lead_h, hours_since_issue)`, `wx_field="dayN"`. · Файлы: `app/weather.py`, `tests/test_weather.py`, `data/weather_cache/` · Не трогать: `app/config.py`, `app/schemas.py` · Готово, когда: тест проверяет (а) для каждой строки N ≥ `safe_previous_day(lead)`, (б) 48 строк без NaN для t0 = 2026-02-01 00:00 Almaty из кэша, (в) офлайн-загрузка работает; `[READY]` лиду.

## Дальше
- Идеи (к 15:15) — `docs/IDEAS.md`: 5–7 идей, что усилит решение по критериям ТЗ (ценность 15, оригинальность 10, техреализация 25). Стартовые кандидаты: разброс best_match vs gfs как мера неопределённости и предупреждение диспетчеру; поправка на обледенение/плотность воздуха по температуре; детекция простоя турбины в истории и флаг «турбина 2 в ремонте» для прогноза; сводка для диспетчера по-русски (шаблон → LLM); экспорт прогноза в формат заявки на рынок (почасовая таблица МВт при заданной установленной мощности); оценка экономии на небалансе. Каждую — с оценкой и что нужно от других.
- R10 (после ОК лида) — `gfs_seamless` в кэше и в `load_or_fetch`; функция `spread(wx_best, wx_gfs)` → колонка разброса, которую агент использует как признак неопределённости.
- Согласованная идея — реализация в своей зоне или как раздел README/`docs/`.
- После 16:30 — чистый clone на Windows (Git Bash) по README, `/critics` по README и странице, замечания Ансару и лиду.

## Нужно от других

## Готово

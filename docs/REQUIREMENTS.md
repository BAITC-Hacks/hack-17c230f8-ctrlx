# Требования и план — WindCast Agent (кейс ВЭС, Самрук-Казына)

ТЗ — `docs/TASK.md`. Разбор данных и погоды — в разделе «Допущения». Статусы R-ID обновляет лид, /ship переносит их в README.

## Карта баллов
| Критерий (из ТЗ) | Баллы | Чем берём | Как проверят |
|---|---|---|---|
| Соответствие задаче и работоспособность | 25 | 28 последовательных выпусков 31.01–27.02 по 48 ч, каждый — полный цикл агента; CSV-прогноз на весь февраль | `uv run python -m app.cli backtest` без ключей → `outputs/forecasts/february_2026.csv` + логи |
| Техническая реализация | 25 | Агент реально решает: валидирует погоду, выбирает поле по правилу утечки, переключает модель/источник при провале проверок, пересчитывает при обновлении прогона; LLM-планировщик на тех же tools — опция | `runs/<id>/agent_log.jsonl`: шаги, решения, причины; тест на утечку |
| README и воспроизводимость | 25 | 3 команды, офлайн-кэш погоды и данные в репо, macOS + Windows, тесты, smoke со свежего клона | `docs/TESTING.md`, `scripts/smoke.sh` |
| Ценность и применимость | 15 | Прогноз p10/p50/p90 и сводка диспетчеру по-русски; метрики на holdout против персистентности и кривой мощности | таблица метрик в README |
| Потенциал и оригинальность | 10 | Воспроизводимое «обновление входных данных» внутри суток; разброс двух NWP-моделей как мера неопределённости; агент независим от модели | лог с `recompute_if_updated`, колонка `wx_model` |

## Требования
| R-ID | Приоритет | Требование (из ТЗ) | Приёмка: вход → ожидаемый выход | Владелец | Статус |
|---|---|---|---|---|---|
| R1 | must | Загрузка исторических данных двух турбин, приведение к часам, флаги простоя и дыр, время Asia/Almaty → UTC | `data/raw/*.csv` → `data/processed/hourly.parquet` по `HOURLY_COLUMNS`, ~25 000 часов × 2 турбины, лог допущений в stdout | mustafa | ✅ |
| R2 | must | Агент сам получает по координатам архивные прогнозы (Open-Meteo Previous Runs), кэш-first, правило day1/day2/day3 против утечки | `app.weather.load_or_fetch()` → `WEATHER_COLUMNS`; `select_for_issue(wx, t0, hours_since_issue)` → `ISSUE_WEATHER_COLUMNS`; `tests/test_weather.py` проверяет, что для каждой строки `safe_previous_day(lead)` ≤ выбранного N | amirkhan | ✅ (обе координаты и живая сверка — в работе) |
| R3 | must | Модель почасовой выработки: B0 персистентность, B1 кривая мощности на прогнозном ветре (MOS), M1 GBM с квантилями p10/p90; обучение на данных до 31.01.2026 | `uv run python -m app.cli train` → `models/*.pkl` ≤ 50 МБ; `app.models.predict(model_name, features)` → power_t1, power_t2, p10, p90 | mustafa | ✅ |
| R4 | must | Ретроспектива: выпуск на 31.01, 01.02, … 27.02, каждый на 24–48 ч почасово | `backtest` → 28 файлов `outputs/forecasts/issue_YYYY-MM-DD.csv` (48 строк rev0) + `february_2026.csv` | mustafa | ✅ |
| R5 | must | Agentic-цикл: получение погоды → подготовка → модель → почасовой прогноз → анализ → повторный расчёт при обновлении входных данных; работает без ключей | `runs/<run_id>/agent_log.jsonl` + `report.md` на каждый выпуск; в логе есть `validate_weather`, `analyze`, `recompute_if_updated` с `decision`/`reason`; хотя бы один выпуск с `fallback_used` или пересчётом | mustafa | ✅ |
| R6 | must | README и воспроизводимость: запуск в 3 команды без ключей, macOS и Windows, тесты, smoke | чистый clone → `uv sync && uv run python -m app.cli backtest` < 5 мин; `scripts/smoke.sh` PASS | ansar | 🚧 |
| R7 | should | Метрики на отложенных периодах (январь 2026, февраль 2025) против B0/B1 | `uv run python -m app.cli evaluate --holdout 2026-01` → `outputs/metrics/holdout_2026-01.json` (`MetricsReport`), таблица в `docs/METRICS.md` | mustafa | ✅ |
| R8 | should | Страница: выбор выпуска, график p50 + p10–p90 + B1, лента шагов агента, таблица метрик; API по контракту | `GET /api/issues`, `/api/forecast/{date}`, `/api/metrics`, `/api/runs/{id}/log`, `POST /api/run`; `static/index.html` | ansar | 🚧 |
| R9 | could | LLM-планировщик и сводка диспетчеру (RU) на тех же tools; реальный прогон в репо | `forecast --llm` при `LLM_API_KEY` → лог с `llm != null`; `runs/llm_demo/` закоммичен | mustafa | 🚧 (код готов, нужен ключ; «Спросить агента» в работе) |
| R10 | could | Второй источник NWP (`gfs_seamless`): разброс как неопределённость, фолбэк при провале валидации | `wx_model` в CSV, решение в логе | amirkhan (загрузка, идея) / mustafa (агент) | ✅ (запасной источник и флаг расхождения в агенте) |

## Контракт (меняет только лид)
Код контракта: `app/schemas.py` (модели и наборы колонок) и `app/config.py` (координаты, tz, правило утечки, пути). Ниже — то же словами.

**Часовые наблюдения** `data/processed/hourly.parquet` — строка на (time_utc, turbine): `time_utc, time_local, turbine, ws, power, temp, n_samples, flag_downtime, flag_gap`. Час = среднее по ≥ 4 из 6 десятиминуток, иначе NaN и `flag_gap=1`. `flag_downtime=1`, если power ≤ 0.01 при ws > 5 м/с.

**Погода** `app.weather.load_or_fetch(model="best_match", refresh=False)` → DataFrame `time_utc, ws100_d1, ws100_d2, ws100_d3, ws10_d1, ws10_d2, ws10_d3, dir100_d2, temp2m_d2, gust10_d2` (UTC, м/с, °C). Кэш: `data/weather_cache/prev_runs_<model>.json` (сырой ответ API) + `meta.json` (url, fetched_at, sha256). `select_for_issue(wx, issue_time_utc, hours_since_issue=0)` → строки на 48 целевых часов: `target_time_utc, lead_h, wx_field(day1|day2|day3), wx_model, ws100, ws10, dir100, temp2m, gust10`; поле выбирается через `config.safe_previous_day(lead_h, hours_since_issue)`.

**Признаки и модели** (`app.features.select_many(wx, t0s, hours_since_issue)` → строки «выпуск × опережение» с допустимым полем погоды; `app.features.add_features`; `WindCastModel.predict(frame, model_name)` → `target, lead, power_t1, power_t2, power_farm, p10, p90, pc`). Модели: `persistence` (среднее 24 ч до выпуска), `power_curve` (бины 0,5 м/с по прогнозному ws100, монотонная, отдельно для day1/day2/day3), `gbm` (HistGradientBoosting из scikit-learn: медиана и квантили 0,1/0,9 с CQR-калибровкой; признаки: ws100, ws100³, ws10, сдвиг ветра, порывы, sin/cos направления, температура, 1/T, sin/cos часа, месяц, опережение, поле, эпоха источника, выход кривой мощности), `climatology` (месяц × час). Выход клипуется в [0, 1].

**Прогноз** `outputs/forecasts/issue_YYYY-MM-DD.csv` и объединение `february_2026.csv` — колонки `ForecastRow`:
`issue_time_utc, issue_time_local, target_time_utc, target_time_local, lead_h, horizon(24h|48h), revision(0|1), power_t1, power_t2, power_farm, p10, p90, ws100_fc, wx_field, wx_model, model_name, fallback_used, run_id`.
Пример строки: `2026-01-31T19:00:00Z,2026-02-01T00:00:00+05:00,2026-02-02T07:00:00Z,2026-02-02T12:00:00+05:00,36,48h,0,0.41,0.39,0.40,0.22,0.63,8.1,day2,best_match,gbm,false,20260201T0000-a1b2`

**Лог агента** `runs/<run_id>/agent_log.jsonl` — строка = `AgentStep`: `{"ts","run_id","issue_time","step","tool","args","status":"ok|warn|fail","summary","decision","reason","duration_ms","llm":{"provider","model","tokens"}|null}`. Рядом `report.md` (сводка диспетчеру).

**Метрики** `outputs/metrics/holdout_<период>.json` — `MetricsReport{period, train_end, rows:[{model, horizon(24h|48h|all), mae, rmse, nmae, bias, skill_vs_persistence, skill_vs_power_curve, n}], created_at}`.

**CLI** (`app/cli.py`): `forecast --issue 2026-01-31 [--refresh] [--llm]` · `backtest [--from 2026-01-31] [--to 2026-02-27]` · `train` · `evaluate --holdout 2026-01`. По умолчанию офлайн из кэша; `--refresh` идёт в API.

**API** (`app/api/routes.py`, префикс `/api`): `GET /health` · `GET /issues → list[IssueListItem]` · `GET /forecast/{issue_date} → ForecastIssue` · `GET /metrics → list[MetricsReport]` · `GET /runs/{run_id}/log → list[AgentStep]` · `POST /run (RunRequest) → RunResponse`.

**Шов для тестов и smoke:** CLI `backtest` и `GET /api/forecast/2026-01-31`.

## Форматы входа и выхода
Вход: `data/raw/turbine{1,2}.csv` (организаторы; sha256 в README), `data/weather_cache/*.json` (Open-Meteo). Выход: `outputs/forecasts/*.csv`, `outputs/metrics/*.json`, `runs/<run_id>/{agent_log.jsonl,report.md}`, `models/*.pkl`.

## Допущения и вопросы организаторам
Факты по данным (проверено pandas): шаг 10 мин, 11.03.2023–31.01.2026, NaN нет; у турбины 1 дыра 18.05–17.07.2024, у турбины 2 пропусков 1,9 %; мощность 0…1 (плато 0,99/0,97); простой ~1 % строк; корреляция турбин по мощности 0,96. Время в файлах — фиксированный UTC+5 на всём ряду (часы SCADA 01.03.2024 не переводились: фаза суточного хода температуры сдвинулась на 6 мин, а не на 60; `config.DATA_TZ`). Итоговые метрики — `outputs/metrics/*.json` и `docs/SOLUTION.md`, раздел 7.

Допущения (в README):
1. «Прогноз на 31 января» = по данным до 31.01 23:50, t0 = 01.02 00:00 Asia/Almaty; горизонт 48 ч (часы 0–23 = «24h», 24–47 = «48h»). Выпуски по дням наблюдения 31.01…27.02 — 28 штук.
2. Архивные прогнозы = Open-Meteo Previous Runs API (`previous_dayN`, без ключа). Правило: `day1` при опережении ≤ 16 ч, `day2` ≤ 40 ч, иначе `day3` (init ≤ T − 24N, задержка публикации 7 ч — измерена для ECMWF IFS). Проверяется тестом на каждую строку и «отравленным» тестом.
3. «Обновление входных данных» воспроизводится пересчётом в t0 + 12 ч (rev1): более свежие прогоны становятся допустимыми; пересчитываются часы не раньше чем через 2 ч (опережение ≥ 14 ч), как внутрисуточная корректировка по п. 97–99 Правил оптового рынка.
4. Обучение только на прогнозной погоде (с 18.02.2024 до 01.02.2026 00:00 по Алматы); 2023 год не используется — для него нет архива прогонов.
5. Данные организаторов коммитим в репо (12 МБ), чтобы эксперт запустил без наших аккаунтов.

Вопросы организаторам: t0 (конец 31.01 или начало)? Есть ли факт за февраль и метрика? Можно ли коммитить CSV? Засчитывается ли Open-Meteo Previous Runs?

## MVP-срез
- К 15:50 (must): R1–R6 на модели `power_curve`; `gbm` подключается заменой `model_name`.
- Если останется время: R7 метрики, R8 страница, R9 LLM-прогон, R10 GFS-разброс.
- Не делаем: Next.js, Supabase, обучение на historical-forecast 2023, парк из N турбин, деплой (только если лид успеет после 16:30).

## Стек
`py`: FastAPI + pandas + pydantic + scikit-learn + lightgbm + pyarrow (все в `uv.lock`). Данные, ML и пакетный прогон — Python; UI — одна статическая страница с Chart.js (cdnjs).

## Владение
| Поток | Кто | Почему он |
|---|---|---|
| Данные, модели, хранилище, агент (orchestrator/tools/log/llm_planner), контракт, CLI | mustafa | лид; ML и LLM-интеграции; держит контракт и интеграцию |
| Платформа: API-эндпоинты, страница (`ui-craft`), README, тесты API/CLI, smoke, `docs/TESTING.md` | ansar | FastAPI, сильный README; платформа — лицо решения для жюри |
| Погода и кэш (R2), второй источник NWP (R10), идеи и новые фичи в `docs/IDEAS.md` → лиду | amirkhan | генерирует идеи и предлагает функции; погода — изолированный модуль с тестом, даёт коммиты в его зоне |

Каждый пушит сам через `scripts/checkpoint.sh` не реже раза в 30 мин: организаторы смотрят коммиты каждого участника.

Зоны — `docs/ZONES.md`, текущие задачи — `docs/tasks/mustafa.md`, `amirkhan.md`, `ansar.md`.

## План по часам
| Checkpoint | Мустафа | Ансар | Амирхан |
|---|---|---|---|
| 14:45 | образец выпуска в `outputs/forecasts/` и `runs/` (есть); `data.py` → `hourly.parquet` | `api/routes.py` на образце: все GET-эндпоинты | `weather.py`: кэш с day1–3 + ws10 + gfs, `select_for_issue`, тест |
| 15:15 | `models.py` power_curve + `train`; `orchestrator.py` первый выпуск end-to-end | `static/index.html`: выпуск, график p50 + p10–p90, лента агента | `docs/IDEAS.md`: 5–7 идей с оценкой ценность/время; первая согласована с лидом |
| 15:50 | `backtest` 28 выпусков, rev1-пересчёт, логи | README черновик, `tests/test_api.py`, smoke зелёный | R10: `gfs_seamless` в кэше, разброс моделей как поле для агента |
| 16:15 | gbm с квантилями, `evaluate` январь 2026, `docs/METRICS.md`; LLM-прогон | страница на 28 выпусках, метрики, `docs/TESTING.md` | реализация согласованной идеи в своей зоне или в `docs/` |
| 16:30 | ФРИЗ фич | | |
| 16:50 | `/critics`, чистый clone macOS | README финал, скриншот, сдача на платформе (с Мустафой) | чистый clone Windows, `/critics` по README |
| 17:40 | финальный push | | |

## Риски
| Риск | Страховка |
|---|---|
| Неверная трактовка t0/горизонта | 48 ч с `lead_h` и `horizon`, допущение в README, вопрос организаторам |
| Open-Meteo лежит или лимитирует у экспертов | офлайн-кэш в репо, `--refresh` только по флагу |
| Обвинение в утечке будущего | правило в `config.safe_previous_day` (задержка 7 ч), тест на каждой строке, «отравленный» тест, запас публикации в журнале, `wx_field` в каждой строке |
| `gbm` не успеваем | `power_curve` сдаётся в 15:50, агент модель-агностичен |
| Windows у Амирхана | pathlib, utf-8 (`app/console.py`), без bash в основном пути |
| Ключи в git | `.env.local` в `.gitignore`, `scripts/secret-scan.sh` в pre-commit |

## «Вау»: уникальность и польза (только после всех must)
Агент не просто прогнозирует, а живёт во времени: в t0 + 12 ч замечает новый прогон, пересчитывает остаток горизонта и показывает диспетчеру, что изменилось и почему; расхождение ECMWF-подобного `best_match` и GFS даёт честную полосу неопределённости p10–p90 и предупреждение «доверие низкое».

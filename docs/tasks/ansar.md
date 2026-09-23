# ansar — задачи

<!-- Меняет только ansar (или его агент). Остальные читают: scripts/sync.sh показывает «Сейчас» и «Нужно от других» у всех. -->

Роль: **платформа** — API, страница, README, тесты API/CLI, smoke. Всё, что видит жюри. Стиль: красиво, чётко, минималистично, понятно; UI — по скиллу `ui-craft`, текст по-русски, без лишних экранов. Пуш через `scripts/checkpoint.sh` каждые ≤ 30 мин.

## Сейчас
- R8 (шаг 1, к 14:50) — `app/api/routes.py`: эндпоинты по контракту `docs/REQUIREMENTS.md` → «Контракт» / `app/schemas.py`, читают файлы с диска (агента ещё нет, но **образец уже лежит в репо**: `outputs/forecasts/issue_2026-01-31.csv`, `runs/20260201T0000-sample/agent_log.jsonl` и `report.md`):
  - `GET /api/issues → list[IssueListItem]` — по файлам `outputs/forecasts/issue_*.csv` (run_id, model_name, fallback_used берутся из строк, revisions = число уникальных `revision`);
  - `GET /api/forecast/{issue_date} → ForecastIssue` — строки CSV → `ForecastRow`, `summary` = текст `runs/<run_id>/report.md`, 404 если нет файла;
  - `GET /api/runs/{run_id}/log → list[AgentStep]` — через `app.agent.log.RunLog.read(run_id)`;
  - `GET /api/metrics → list[MetricsReport]` — все `outputs/metrics/*.json` (пока пусто → `[]`);
  - `POST /api/run (RunRequest) → RunResponse` — вызывает `app.service.forecast(...)`; пока он бросает `NotImplementedError` — отвечай 503 с текстом «агент ещё не подключён».
  · Файлы: `app/api/routes.py`, `tests/test_api.py` (на образце: 200 и 48 строк для 2026-01-31, 404 для 2026-03-01, лог ≥ 7 шагов) · Не трогать: `app/schemas.py`, `app/config.py`, `outputs/`, `runs/` (это зона лида; нужен другой образец — попроси) · Готово, когда: `uv run pytest -q` зелёный, `curl localhost:8000/api/forecast/2026-01-31` отдаёт JSON с 48 строками.

## Дальше
- R8 (шаг 2, к 15:30) — `static/index.html`, одна страница, `ui-craft`: (1) шапка: название, одна фраза, режим demo/llm из `/api/health`; (2) выбор выпуска (список из `/api/issues`, стрелки ← →); (3) график 48 ч: линия `power_farm`, полоса p10–p90, переключатель турбина 1/2/парк, вертикальная граница 24h|48h, подпись поля погоды (`wx_field`) при наведении — Chart.js с cdnjs (`https://cdnjs.cloudflare.com/ajax/libs/Chart.js/...`), без сборки; (4) лента агента из `/api/runs/{id}/log`: шаг, инструмент, статус (ok/warn/fail цветом), summary, decision → reason, длительность; (5) сводка диспетчеру — `summary` (markdown → простой текст/абзацы); (6) таблица метрик из `/api/metrics` (появится позже, пока «метрики считаются»). Мобильная ширина не обязательна, 1280×800 обязательна. Проверять через встроенный браузер (`read_page`/`find`), не по координатам.
- R6 (с 15:30) — README по шаблону: быстрый старт 3 команды без ключей (`uv sync` → `uv run python -m app.cli backtest` → `uv run uvicorn app.main:app --port 8000`), sha256 файлов `data/raw/` (посчитать на своём клоне после checkout), правило против утечки словами (day1 ≤ 17 ч, day2 ≤ 41 ч, иначе day3; init + 6 ч ≤ t0), допущение про t0, таблица метрик (даст лид), трассировка R-ID, раздел «Как проверить решение». `docs/TESTING.md`, `scripts/smoke.sh` (SMOKE_PATH → `GET /api/forecast/2026-01-31`, метод GET), `tests/test_cli.py` расширить на `backtest --from 2026-01-31 --to 2026-01-31`, когда лид подключит агента.
- После 16:30 — только фиксы, README, скриншот 1280×800 в README, сдача на платформе вместе с Мустафой.

## Нужно от других
- mustafa: `app.service.forecast` реальный (R5) — ориентир 15:15; метрики `outputs/metrics/*.json` — 16:15.

## Готово

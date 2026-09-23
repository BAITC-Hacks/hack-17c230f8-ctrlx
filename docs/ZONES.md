# Команда и зоны владения

Машиночитаемый файл: его читают `scripts/team.sh`, `zones.sh` (pre-commit), `setup.sh`, `sync.sh` и clock-хук.
- `MEMBER: <id> <Имя> <GitHub-логин> <GitHub-id>` — кто есть кто. По логину агент узнаёт, на кого работает; коммиты идут с noreply-адреса этого аккаунта.
- `LEAD` — лид-интегратор: ему принадлежит всё неназначенное (конфиги, `package.json`, lockfile, `docs/TEAM.md`).
- Строки зон `<id>: путь путь …` (префиксы через пробел) добавляет `/kickoff` после выдачи ТЗ; дальше файл меняет только лид.

Правила:
- Менять и удалять **существующие** файлы можно только в своей зоне. Новые файлы создавать можно, но в своих каталогах.
- Свой `docs/tasks/<id>.md` каждый меняет сам. `ALL` — общие файлы.
- Согласованная правка чужого файла: `ZONE_OK=1 scripts/checkpoint.sh "..."`.
- Пока строк зон нет, проверка выключена. Пример строки: `amirkhan: app/page.tsx components/ public/`.

MEMBER: mustafa Мустафа mustafa-kassym 171173323
MEMBER: amirkhan Амирхан advertising20240-hiii 248465019
MEMBER: ansar Ансар ansarchik17 185749198
LEAD: mustafa
ALL: docs/PROGRESS.md
mustafa: app/agent/ app/schemas.py app/config.py app/service.py app/cli.py app/llm.py app/console.py app/__init__.py app/api/__init__.py app/data.py app/features.py app/models.py app/train.py app/evaluate.py app/store.py data/raw/ data/processed/ models/ outputs/ runs/ AGENTS.md CLAUDE.md docs/REQUIREMENTS.md docs/ZONES.md docs/TASK.md docs/PREPARED.md docs/METRICS.md pyproject.toml uv.lock requirements.txt .env.example Dockerfile tests/test_data.py tests/test_models.py tests/test_agent.py
ansar: app/main.py app/api/routes.py static/ tests/test_api.py tests/test_cli.py README.md docs/TESTING.md scripts/smoke.sh
amirkhan: app/weather.py app/ask.py data/weather_cache/ tests/test_weather.py tests/test_ask.py docs/IDEAS.md

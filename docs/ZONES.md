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

#!/usr/bin/env bash
# UserPromptSubmit hook: one line of context per prompt — time left, your role and zone, push freshness —
# so agents size the work to the clock and stay inside their zone.
# cut -c counts bytes in the C locale and would split Cyrillic mid-character
export LC_ALL="${LC_ALL:-en_US.UTF-8}"
now=$(date +%s)
day=$(date +%Y-%m-%d)
hm=$(date +%H:%M)
at() { date -j -f '%Y-%m-%d %H:%M' "$day $1" +%s 2>/dev/null || date -d "$day $1" +%s; }
left() {
  m=$(( ($1 - now) / 60 ))
  if [ "$m" -ge 60 ]; then echo "$((m / 60))ч$((m % 60))м"; else echo "${m}м"; fi
}

head="⏱ $hm"
root=$(git rev-parse --show-toplevel 2>/dev/null)
role=$(git config ctrlx.role 2>/dev/null || true)
team_line=""
if [ -n "$role" ] && [ -x "$root/scripts/team.sh" ]; then
  T="$root/scripts/team.sh"
  zone=$( [ -f "$root/docs/ZONES.md" ] && grep -E "^$role:" "$root/docs/ZONES.md" | head -1 | cut -d: -f2- )
  head="$head · ты работаешь на $("$T" name "$role") (@$("$T" login "$role"))${zone:+, зона:$zone}"
  for id in $("$T" ids); do
    [ "$id" = "$role" ] && continue
    cur=$(awk '$0 == "## Сейчас" {on=1; next} /^## /{on=0} on && NF' "$root/docs/tasks/$id.md" 2>/dev/null | head -1 | cut -c1-60)
    team_line="$team_line${team_line:+; }$("$T" name "$id"): ${cur:-—}"
  done
  [ -n "$team_line" ] && team_line=" · команда: $team_line"
fi
push=""
if t=$(git log -1 --format=%ct '@{u}' 2>/dev/null); then
  push=" · последний push команды $(( (now - t) / 60 ))м назад"
  n=$(git rev-list --count '@{u}..HEAD' 2>/dev/null || echo 0)
  [ "$n" != "0" ] && push="$push · у тебя не запушено: $n"
fi

push="$push$team_line"
# unread team-channel messages ride along with the prompt, so the agent sees them without being asked
chat=""; [ -n "$role" ] && [ -x "$root/scripts/msg.sh" ] && chat=$("$root/scripts/msg.sh" hook 2>/dev/null)
if [ "$day" != "2026-09-23" ]; then echo "$head$push"; [ -n "$chat" ] && echo "$chat"; exit 0; fi
start=$(at 13:00); freeze=$(at 16:30); final=$(at 17:40); end=$(at 18:00)
if [ "$now" -lt "$start" ]; then
  echo "$head · до старта $(left "$start")$push"
elif [ "$now" -lt "$freeze" ]; then
  echo "$head · до фриза фич (16:30) $(left "$freeze") · до финального push (17:40) $(left "$final")$push"
elif [ "$now" -lt "$final" ]; then
  echo "$head · ФРИЗ: только фиксы, тесты, README · до финального push (17:40) $(left "$final")$push"
elif [ "$now" -lt "$end" ]; then
  echo "$head · ФИНАЛ: до 18:00 $(left "$end") — только push и сдача$push"
else
  echo "$head · после 18:00 изменения не учитываются (п. 5.4.13)$push"
fi
[ -n "$chat" ] && echo "$chat"
exit 0

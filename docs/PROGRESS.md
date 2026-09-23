# Прогресс по часам (п. 5.4.8)

Формат: `- ЧЧ:ММ · кто · что сделано · тесты`. Строки добавляет `scripts/checkpoint.sh`.

- 13:21 · mustafa · Mustafa Kassym · chore: team channel remote is configurable · тесты: n/a
- 13:24 · mustafa · Мустафа · docs: task text for both candidate cases · тесты: n/a
- 13:25 · mustafa · Мустафа · chore: team channel back in the team repo · тесты: n/a
- 14:19 · mustafa · Мустафа · kickoff: wind farm case (Samruk-Kazyna), contract, zones, tasks, data and weather cache (R1-R10) · тесты: pass
- 14:31 · mustafa · Мустафа · roles: platform=ansar, data+models+agent=mustafa, weather+ideas=amirkhan; sample issue for the platform (R4, R8) · тесты: pass
- 14:38 · amirkhan · Амирхан · feat: weather module with leak-safe previous-run selection and cache for both models (R2) · тесты: pass
- 14:40 · ansar · Ансар · feat(api): forecast endpoints on the sample issue (R8) · тесты: pass
- 15:01 · ansar · Ансар · feat(ui): forecast page — p10-p90 band tinted by weather-run staleness, agent trace (R8) · тесты: pass
- 15:06 · mustafa · Мустафа · sample issue on the new cache: revision 1 recompute at t0+12h, readable dispatcher report; API tests follow the two-revision contract (R5, R8) · тесты: pass
- 15:12 · ansar · Ансар · fix(ui): newest revision wins per hour; show what the t0+12h recompute changed (R8) · тесты: pass
- 15:15 · mustafa · Мустафа · docs: SOLUTION.md architecture and logic; data loader (fixed UTC+5 clock); publish delay 7 h per measured ECMWF availability (R1, R2, R5) · тесты: pass
- 15:16 · ansar · Ансар · docs: README, TESTING and smoke for the wind-farm case (R6) · тесты: pass
- 15:17 · mustafa · Мустафа · docs: SOLUTION.md — bid alignment (D+2 = day-ahead bid before 08:00), poison leak test, decision ledger, regulator KPIs (R5, R7) · тесты: pass
- 15:21 · mustafa · Мустафа · models: leak-safe issue simulation, power curve per field, LightGBM median + CQR quantiles; train and hold-out evaluate (Jan-2026 nMAE 15.4%, Feb-2025 17.7%) (R3, R7) · тесты: pass
- 15:22 · amirkhan · Амирхан · docs(ideas): 8 ideas with measured numbers and sources for README (R10, IDEA-1..8) · тесты: pass
- 15:25 · amirkhan · Амирхан · docs(ideas): idea 1 aligned with SOLUTION 7.5 — Nurly 5 MW, BR corridor ±5 %, contract regimes (IDEA-1) · тесты: pass
- 15:26 · mustafa · Мустафа · agent: real orchestrator (validate, fallback ladder, recompute at t0+12h for hours >=2 h ahead, out-of-sample reflection, dispatcher report), 28-issue backtest + february_2026.csv, poison/determinism tests; API tests on real output (R4, R5) · тесты: pass
- 15:29 · mustafa · Мустафа · models: switch GBM to scikit-learn HistGradientBoosting (no system libomp on macOS), drop lightgbm dependency; retrain and regenerate 28 issues (R3, R6) · тесты: pass

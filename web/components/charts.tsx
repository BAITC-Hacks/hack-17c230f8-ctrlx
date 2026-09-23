"use client";

import { useState } from "react";
import {
  type ForecastRow,
  RATED_MW,
  WX_FIELD_LABEL,
  dayLabel,
  hhmm,
  latestRows,
  mw,
  pct,
} from "@/lib/api";

const W = 880;
const H = 280;
const PAD = { l: 44, r: 12, t: 16, b: 34 };
const X = (lead: number) => PAD.l + (lead / 47) * (W - PAD.l - PAD.r);
const Y = (share: number) => PAD.t + (1 - share) * (H - PAD.t - PAD.b);

function path(points: [number, number][]) {
  return points.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
}

/** 48-hour forecast: p10–p90 band, published line, revision 0 dashed where the agent recomputed. */
export function ForecastChart({ rows, series = "power_farm" }: {
  rows: ForecastRow[];
  series?: "power_farm" | "power_t1" | "power_t2";
}) {
  const [hover, setHover] = useState<ForecastRow | null>(null);
  const latest = latestRows(rows);
  const rev0 = rows.filter((r) => r.revision === 0).sort((a, b) => a.lead_h - b.lead_h);
  const recomputed = new Set(rows.filter((r) => r.revision === 1).map((r) => r.lead_h));
  const band =
    path(latest.map((r) => [X(r.lead_h), Y(r.p90)])) +
    latest
      .slice()
      .reverse()
      .map((r) => `L${X(r.lead_h).toFixed(1)},${Y(r.p10).toFixed(1)}`)
      .join("") +
    "Z";
  const line = path(latest.map((r) => [X(r.lead_h), Y(r[series])]));
  const old = path(rev0.filter((r) => recomputed.has(r.lead_h)).map((r) => [X(r.lead_h), Y(r[series])]));
  const firstRecomputed = Math.min(...recomputed);
  const station = series === "power_farm"; // the p10–p90 band is modelled for the station only
  const toMw = (share: number) =>
    `${(share * (station ? RATED_MW : RATED_MW / 2)).toFixed(1).replace(".", ",")} МВт`;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img"
        aria-label="Почасовой прогноз выработки на 48 часов с коридором p10–p90">
        {[0, 0.25, 0.5, 0.75, 1].map((v) => (
          <g key={v}>
            <line x1={PAD.l} x2={W - PAD.r} y1={Y(v)} y2={Y(v)} className="stroke-border" />
            <text x={PAD.l - 8} y={Y(v) + 4} textAnchor="end" className="fill-muted-foreground text-[11px]">
              {v * 100}
            </text>
          </g>
        ))}
        {station && <path d={band} className="fill-primary/15" />}
        <line x1={X(24)} x2={X(24)} y1={PAD.t} y2={H - PAD.b} className="stroke-foreground/40" strokeDasharray="4 4" />
        <text x={X(24) + 6} y={PAD.t + 12} className="fill-muted-foreground text-[11px]">
          сутки D+2 · суточная заявка
        </text>
        {Number.isFinite(firstRecomputed) && (
          <>
            <line x1={X(firstRecomputed)} x2={X(firstRecomputed)} y1={PAD.t} y2={H - PAD.b}
              className="stroke-primary/50" strokeDasharray="2 3" />
            <text x={X(firstRecomputed) + 6} y={H - PAD.b - 8} className="fill-primary text-[11px]">
              пересчёт в 12:00
            </text>
          </>
        )}
        {old && <path d={old} fill="none" className="stroke-foreground/45" strokeWidth={1.5} strokeDasharray="5 4" />}
        <path d={line} fill="none" className="stroke-primary" strokeWidth={2.4} strokeLinejoin="round" />
        {latest.filter((r) => r.lead_h % 6 === 0).map((r) => (
          <text key={r.lead_h} x={X(r.lead_h)} y={H - 12} textAnchor="middle"
            className="fill-muted-foreground text-[11px]">
            {hhmm(r.target_time_local) === "00:00" ? dayLabel(r.target_time_local) : hhmm(r.target_time_local)}
          </text>
        ))}
        {latest.map((r) => (
          <rect key={r.lead_h} x={X(r.lead_h) - 9} y={PAD.t} width={18} height={H - PAD.t - PAD.b}
            fill="transparent" onMouseEnter={() => setHover(r)} onMouseLeave={() => setHover(null)} />
        ))}
        {hover && <circle cx={X(hover.lead_h)} cy={Y(hover[series])} r={4} className="fill-primary" />}
      </svg>
      <div className="mt-1 min-h-10 text-sm text-muted-foreground" aria-live="polite">
        {hover ? (
          <span>
            <b className="text-foreground">{dayLabel(hover.target_time_local)}, {hhmm(hover.target_time_local)}</b>
            {" · "}{pct(hover[series])} ({toMw(hover[series])})
            {station ? ` · коридор ${pct(hover.p10)}–${pct(hover.p90)}` : " · номинал турбины 2,5 МВт"}
            {" · "}ветер {hover.ws100_fc ?? "—"} м/с · {WX_FIELD_LABEL[hover.wx_field]}
            {hover.revision === 1 ? " · пересчитано" : ""}
          </span>
        ) : (
          <span>Наведите на график: час, мощность, коридор и какой прогон погоды использован.</span>
        )}
      </div>
    </div>
  );
}

export interface HeatCell {
  day: string; // YYYY-MM-DD local
  hour: number; // 0..23 local
  value: number; // share of rated power
}

/** February calendar: one row per day, 24 hourly cells coloured by expected output. */
export function Heatmap({ cells, onPick }: { cells: HeatCell[]; onPick?: (day: string) => void }) {
  const days = [...new Set(cells.map((c) => c.day))].sort();
  const byKey = new Map(cells.map((c) => [`${c.day}|${c.hour}`, c.value]));
  const cw = 26, ch = 16, lw = 92;
  const [hover, setHover] = useState<HeatCell | null>(null);
  return (
    <div>
      <div className="overflow-x-auto">
        <svg viewBox={`0 0 ${lw + 24 * cw} ${days.length * ch + 22}`} className="min-w-[640px] w-full"
          role="img" aria-label="Тепловая карта ожидаемой выработки по дням и часам февраля">
          {Array.from({ length: 24 }, (_, h) => h).filter((h) => h % 3 === 0).map((h) => (
            <text key={h} x={lw + h * cw + cw / 2} y={12} textAnchor="middle" className="fill-muted-foreground text-[10px]">
              {String(h).padStart(2, "0")}
            </text>
          ))}
          {days.map((d, i) => (
            <g key={d} className={onPick ? "cursor-pointer" : undefined} onClick={() => onPick?.(d)}>
              <text x={lw - 8} y={22 + i * ch + ch / 2 + 3} textAnchor="end" className="fill-foreground text-[10px]">
                {dayLabel(d)}
              </text>
              {Array.from({ length: 24 }, (_, h) => {
                const v = byKey.get(`${d}|${h}`);
                return (
                  <rect key={h} x={lw + h * cw + 1} y={20 + i * ch + 1} width={cw - 2} height={ch - 2} rx={2}
                    fill={v === undefined ? "var(--muted)" : `color-mix(in oklab, var(--primary) ${Math.round(8 + v * 88)}%, white)`}
                    onMouseEnter={() => v !== undefined && setHover({ day: d, hour: h, value: v })}
                    onMouseLeave={() => setHover(null)} />
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span aria-live="polite">
          {hover
            ? `${dayLabel(hover.day)}, ${String(hover.hour).padStart(2, "0")}:00 — ${pct(hover.value)} (${mw(hover.value)})`
            : onPick ? "Нажмите на день, чтобы открыть его выпуск." : "Наведите на час."}
        </span>
        <span className="flex items-center gap-2">
          штиль
          <span className="h-2.5 w-24 rounded-sm"
            style={{ background: "linear-gradient(90deg, color-mix(in oklab, var(--primary) 8%, white), var(--primary))" }} />
          номинал
        </span>
      </div>
    </div>
  );
}

/** Horizontal bars for a small set of labelled values (lower is better unless said otherwise). */
export function Bars({ items, highlight, format }: {
  items: { label: string; value: number }[];
  highlight?: number;
  format?: (v: number) => string;
}) {
  const max = Math.max(...items.map((i) => i.value), 1e-9);
  return (
    <div className="flex flex-col gap-2">
      {items.map((it, i) => (
        <div key={it.label} className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)_4.5rem] items-center gap-3 text-sm">
          <span className="truncate" title={it.label}>{it.label}</span>
          <span className="h-2.5 rounded-sm bg-muted">
            <span className={i === highlight ? "block h-full rounded-sm bg-primary" : "block h-full rounded-sm bg-chart-4"}
              style={{ width: `${(it.value / max) * 100}%` }} />
          </span>
          <span className="text-right tabular-nums">{format ? format(it.value) : it.value}</span>
        </div>
      ))}
    </div>
  );
}

// src/App.tsx
import React, { useEffect, useMemo, useState } from "react";
import { onAuthStateChanged, signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider, db } from "./firebase";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";

/* =======================
   Types
======================= */

type DayKey = "sun" | "mon" | "tue" | "wed" | "thu" | "fri" | "sat";

type TimeBlock = { start: number; end: number }; // minutes since midnight

type DayWindow = { day: DayKey; blocks: TimeBlock[] };

type Client = {
  id: string;
  color: string;
  supPercent: number;
  minSessionMins: number;
  maxSessionsPerWeek: number | null;
  maxSessionsPerDay: number | null; // NEW
  preferNoSubHour: boolean;
  preferredDaySlots: DayKey[][];
  windows: DayWindow[];
};

type Supervisor = {
  roundingMinutes?: number;
  dailyAvail: Record<DayKey, TimeBlock[]>;
  oneOffUnavail?: Record<string, TimeBlock[]>;
  unavailableDays?: string[];
};
type ScheduledBlock = {
  date: string;
  clientId: string;
  start: number;
  end: number;
};

type ScheduleRequest = {
  startDate: string;
  endDate: string;
  clients: Client[];
  supervisor: Supervisor;
};

type SB = ScheduledBlock;

const lockKey = (b: SB) => `${b.date}|${b.clientId}|${b.start}|${b.end}`;

type AppUser = {
  uid: string;
  displayName?: string | null;
  email?: string | null;
  photoURL?: string | null;
} | null;

/* =======================
   Utilities (dates, time, math, downloads)
======================= */

const DAYS: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DATE_FMT = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
const parseISO = (iso: string) => {
  const [y, m, d] = (iso || "").split("-").map(Number);
  return new Date(y || 1970, (m || 1) - 1, d || 1, 0, 0, 0, 0);
};
const daterange = (startISO: string, endISO: string) => {
  const a = parseISO(startISO);
  const b = parseISO(endISO);
  const out: Date[] = [];
  const cur = new Date(a);
  while (cur <= b) {
    out.push(new Date(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
};
const addDays = (d: Date, n: number) => {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
};
const pad2 = (n: number) => String(n).padStart(2, "0");
const toHHMM = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const h12 = ((h + 11) % 12) + 1;
  const am = h < 12 ? "am" : "pm";
  return `${h12}:${pad2(m)} ${am}`;
};
const to24 = (mins: number) =>
  `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
const overlapBlocks = (a: TimeBlock[], b: TimeBlock[]) => {
  const out: TimeBlock[] = [];
  for (const x of a) {
    for (const y of b) {
      const s = Math.max(x.start, y.start);
      const e = Math.min(x.end, y.end);
      if (e > s) out.push({ start: s, end: e });
    }
  }
  return out;
};
const subtractBlocks = (base: TimeBlock[], minus: TimeBlock[]) => {
  let slots = [...base];
  for (const m of minus) {
    const next: TimeBlock[] = [];
    for (const s of slots) {
      if (m.end <= s.start || m.start >= s.end) {
        next.push(s);
        continue;
      }
      if (m.start > s.start) next.push({ start: s.start, end: m.start });
      if (m.end < s.end) next.push({ start: m.end, end: s.end });
    }
    slots = next;
  }
  return slots.sort((x, y) => x.start - y.start);
};
const snapRangeToGrid = (blk: TimeBlock, grid: number): TimeBlock => {
  const s = Math.ceil(blk.start / grid) * grid;
  const e = Math.floor(blk.end / grid) * grid;
  return e > s ? { start: s, end: e } : { start: 0, end: 0 };
};
const hh = (nMin: number) => `${(nMin / 60).toFixed(2)}h`;
const parseHoursToMin = (v: string): number | null => {
  if (!v?.trim()) return null;
  const n = Number(v.replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? Math.round(n * 60) : null;
};

// Return supervisor availability for a specific date (already snapped & sorted)
function supAvailForDate(req: ScheduleRequest, date: Date): TimeBlock[] {
  const dk = DAYS[date.getDay()] as DayKey;
  const base = (req.supervisor.dailyAvail?.[dk] || [])
    .map((b) => ({ start: b.start | 0, end: b.end | 0 }))
    .filter((b) => b.end > b.start)
    .sort((a, b) => a.start - b.start);
  return base;
}

// Free time for a date when all OTHER clients (except excludeId) are placed.
// (We subtract other clients' scheduled blocks from the supervisor's base availability.)
function freeForDateExcludingClient(
  req: ScheduleRequest,
  schedule: ScheduledBlock[],
  dateISO: string,
  excludeClientId?: string
): TimeBlock[] {
  const date = parseISODateLocal(dateISO);
  let free = supAvailForDate(req, date);
  const used = schedule
    .filter((b) => b.date === dateISO && b.clientId !== excludeClientId)
    .map((b) => ({ start: b.start, end: b.end }));
  if (used.length) free = subtractBlocks(free, used);
  return free;
}

// After initial placement, try to merge multiple <60m blocks for the same client on the same day
function consolidateShortSessions(
  req: ScheduleRequest,
  schedule: ScheduledBlock[],
  grid: number
): ScheduledBlock[] {
  const MIN_ONE_HOUR = 60;

  // Do a couple of passes in case merges open up new opportunities
  for (let pass = 0; pass < 2; pass++) {
    let changed = false;

    // index by client/date
    const byClientDate = new Map<string, ScheduledBlock[]>();
    for (const b of schedule) {
      const k = `${b.clientId}|${b.date}`;
      (byClientDate.get(k) || byClientDate.set(k, []).get(k)!).push(b);
    }

    for (const [key, blocks] of byClientDate) {
      // sort by start
      blocks.sort((a, b) => a.start - b.start);
      const [clientId, dateISO] = key.split("|");

      // collect short blocks (< 60m)
      const shorts = blocks.filter((b) => b.end - b.start < MIN_ONE_HOUR);
      if (shorts.length < 2) continue;

      // Try to merge the two smallest first
      const byLen = [...shorts].sort(
        (a, b) => a.end - a.start - (b.end - b.start)
      );
      const a = byLen[0];
      const b = byLen[1];

      const combined = a.end - a.start + (b.end - b.start);

      // Recompute free time on this date excluding this client
      let free = freeForDateExcludingClient(req, schedule, dateISO, clientId);

      // First attempt: if a and b are adjacent or separated by <= grid and
      // the free blocks cover the span, just collapse into [minStart, minStart+combined]
      const minStart = Math.min(a.start, b.start);
      const maxEnd = Math.max(a.end, b.end);

      // Check if there is enough free time covering [minStart, maxEnd] to host 'combined'
      const spanBlocks = overlapBlocks(
        [{ start: minStart, end: maxEnd }],
        free
      );
      const spanLength = spanBlocks.reduce(
        (s, t) => s + Math.max(0, t.end - t.start),
        0
      );

      const tryPlace = (startCandidate: number): ScheduledBlock | null => {
        const endCandidate = startCandidate + combined;
        // Ensure [startCandidate, endCandidate] is fully free
        const cov = overlapBlocks(
          [{ start: startCandidate, end: endCandidate }],
          free
        );
        const covLen = cov.reduce((s, t) => s + (t.end - t.start), 0);
        if (covLen >= combined) {
          return {
            date: dateISO,
            clientId,
            start: startCandidate,
            end: endCandidate,
          };
        }
        return null;
      };

      let merged: ScheduledBlock | null = null;

      if (spanLength >= combined && maxEnd - minStart <= combined + grid) {
        // Adjacent/nearby: try to place starting at the earliest start
        merged = tryPlace(Math.floor(minStart / grid) * grid);
      }

      // Second attempt: find any free window that can host 'combined'
      if (!merged) {
        const bigEnough = free.find((t) => t.end - t.start >= combined);
        if (bigEnough) {
          const snappedStart = Math.floor(bigEnough.start / grid) * grid;
          merged = {
            date: dateISO,
            clientId,
            start: snappedStart,
            end: snappedStart + combined,
          };
        }
      }

      if (merged) {
        // Remove originals a/b; add merged
        const newSched: ScheduledBlock[] = [];
        let removedA = false,
          removedB = false;
        for (const sb of schedule) {
          if (!removedA && sb === a) {
            removedA = true;
            continue;
          }
          if (!removedB && sb === b) {
            removedB = true;
            continue;
          }
          newSched.push(sb);
        }
        newSched.push(merged);
        schedule = newSched;
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Normalize: within each day/client, merge any accidental adjacency
  schedule.sort((x, y) =>
    x.date === y.date ? x.start - y.start : x.date.localeCompare(y.date)
  );
  const out: ScheduledBlock[] = [];
  for (const b of schedule) {
    const last = out[out.length - 1];
    if (
      last &&
      last.date === b.date &&
      last.clientId === b.clientId &&
      last.end === b.start
    ) {
      last.end = b.end; // fuse
    } else {
      out.push({ ...b });
    }
  }
  return out;
}

// Parse an ISO date string ("2025-09-23") into a local Date (midnight local time)
function parseISODateLocal(iso: string): Date {
  const [y, m, d] = iso.split("-").map((n) => parseInt(n, 10));
  return new Date(y, m - 1, d); // year, monthIndex, day
}

function downloadText(filename: string, content: string) {
  const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
function parseWindowString(s: string): TimeBlock[] {
  const parts = s
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  const out: TimeBlock[] = [];
  for (const p of parts) {
    const m = p.match(/(.+?)-(.+)/);
    if (!m) continue;
    const a = parseClock(m[1].trim());
    const b = parseClock(m[2].trim());
    if (a != null && b != null && b > a) out.push({ start: a, end: b });
  }
  return out;
}

function parseClock(raw: string): number | null {
  const s = raw.toLowerCase().replace(/\s+/g, "");
  const ampm = s.match(/am|pm/);
  const nums = s.replace(/am|pm/g, "");
  const mm = nums.match(/^(\d{1,2})(?::(\d{2}))?$/);
  if (!mm) return null;
  let h = Number(mm[1]);
  const m = mm[2] ? Number(mm[2]) : 0;
  if (ampm) {
    if (h === 12) h = 0;
    if (ampm[0] === "pm") h += 12;
  }
  return h * 60 + m;
}

// Convert a Date → our DayKey ("sun" | "mon" | ... | "sat")
function dayKeyFromDate(d: Date): DayKey {
  const keys: DayKey[] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return keys[d.getDay()];
}

/* =======================
   Default target = sup% x authorized window minutes in [start,end]
======================= */
// Minutes to target for the run if no override is provided.
// Sums client attended minutes in [startISO, endISO], then applies supPercent.
function defaultTargetMinForClientInRange(
  c: Client,
  startISO: string,
  endISO: string
): number {
  const dates = daterange(startISO, endISO);
  let attended = 0; // minutes

  for (const d of dates) {
    const day = dayKeyFromDate(d);
    const wins = (c.windows || []).filter((w) => w.day === day);
    for (const w of wins) {
      for (const b of w.blocks || []) {
        attended += Math.max(0, (b.end | 0) - (b.start | 0));
      }
    }
  }

  const pct = Number.isFinite(c.supPercent) ? c.supPercent : 0;
  const minsFromPct = Math.round((attended * pct) / 100);
  return Math.max(0, minsFromPct);
}

// Rough check: does the client have any window later in the range (after 'date')?
function clientHasFutureWindow(
  c: Client,
  date: Date,
  req: ScheduleRequest
): boolean {
  // start tomorrow
  const start = new Date(date.getTime() + 24 * 60 * 60 * 1000);
  for (const d of daterange(DATE_FMT(start), req.endDate)) {
    const dk = DAYS[d.getDay()] as DayKey;
    if (c.windows?.some((w) => w.day === dk)) return true;
  }
  return false;
}

function maxFeasibleMinutesForDay(
  c: Client,
  day: DayKey,
  avail: TimeBlock[],
  grid: number
): number {
  const cBlocks = (c.windows || [])
    .filter((w) => w.day === day)
    .flatMap((w) => w.blocks || []);
  const feas = overlapBlocks(cBlocks, avail)
    .map((b) => snapRangeToGrid(b, grid))
    .filter((b) => b.end > b.start);
  if (!feas.length) return 0;
  return Math.max(...feas.map((b) => b.end - b.start));
}

/* =======================
   Scheduler (greedy) with fairness & constraints
======================= */

function generateSchedule(
  req: ScheduleRequest,
  seed = 1,
  lockedFixed: ScheduledBlock[] = [],
  targetMap?: Record<string, number>,
  runUnavailableDays: string[] = [],
  runOneOffUnavail: Record<string, TimeBlock[]> = {},
  opts: { biasLonger?: boolean } = {} // <-- NEW
): ScheduledBlock[] {
  const { biasLonger = false } = opts; // <-- NEW
  const rand = (() => {
    let s = seed || 1;
    return () => (s = (1664525 * s + 1013904223) | 0);
  })();

  const sup = req.supervisor;
  const grid = Math.max(5, sup.roundingMinutes || 15);

  // === BEGIN targets init (REPLACEMENT) ===
  const remaining: Record<string, number> = {};
  const targetInit: Record<string, number> = {}; // remember targets for logging
  const minSession: Record<string, number> = {};
  const maxPerWeek: Record<string, number | null> = {};
  const maxPerDay: Record<string, number | null> = {};

  for (const c of req.clients) {
    // targetMap is MINUTES per client (UI should pass minutes if overrides exist)
    const overrideMin = targetMap?.[c.id];

    // Default sup% to 10 if absent so fallback never yields 0 just due to missing percent.
    const pct = Number.isFinite(c.supPercent) ? (c.supPercent as number) : 10;

    const fallbackMin = defaultTargetMinForClientInRange(
      { ...c, supPercent: pct },
      req.startDate,
      req.endDate
    );

    // If both override & fallback resolve to 0, schedule at least one min-length session
    const base = overrideMin != null ? overrideMin : fallbackMin;
    const atLeastOneSession = Math.max(0, c.minSessionMins || 60);
    const val = Math.max(0, Math.round(base || atLeastOneSession));

    targetInit[c.id] = val;
    remaining[c.id] = val;

    minSession[c.id] = Math.max(15, c.minSessionMins || 60);
    maxPerWeek[c.id] =
      c.maxSessionsPerWeek != null ? c.maxSessionsPerWeek : null;
    maxPerDay[c.id] = c.maxSessionsPerDay != null ? c.maxSessionsPerDay : null;
  }
  // === END targets init (REPLACEMENT) ===
  console.log(
    "TARGETS for run:",
    req.clients.map((c) => ({
      id: c.id,
      targetH: (targetInit[c.id] / 60).toFixed(2),
      min: minSession[c.id],
      maxW: maxPerWeek[c.id],
      maxD: maxPerDay[c.id],
    }))
  );

  const weekCount: Record<string, Record<string, number>> = {}; // clientId -> wkISO -> count
  const dayCount: Record<string, Record<string, number>> = {}; // clientId -> dateISO -> count (NEW)
  const weekKey = (d: Date) => {
    const start = new Date(d);
    start.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday start
    return DATE_FMT(start);
  };

  const lockedByDate: Record<string, ScheduledBlock[]> = {};
  for (const b of lockedFixed) (lockedByDate[b.date] ||= []).push(b);

  const scheduled: ScheduledBlock[] = [];

  // ===== Step 1: weekday-balanced date interleaving =====
  const allDates = daterange(req.startDate, req.endDate);
  const byDay: Record<DayKey, string[]> = {
    sun: [],
    mon: [],
    tue: [],
    wed: [],
    thu: [],
    fri: [],
    sat: [],
  };
  for (const d of allDates) {
    const iso = DATE_FMT(d);
    const day = dayKeyFromDate(d);
    byDay[day].push(iso);
  }
  const weekdayOrder: DayKey[] = [
    "mon",
    "tue",
    "wed",
    "thu",
    "fri",
    "sat",
    "sun",
  ];
  const maxLen = Math.max(...weekdayOrder.map((k) => byDay[k].length));
  const interleavedDates: string[] = [];
  for (let i = 0; i < maxLen; i++) {
    for (const k of weekdayOrder) {
      if (byDay[k][i]) interleavedDates.push(byDay[k][i]);
    }
  }
  // ======================================================

  const lastPlacedISO: Record<string, string | undefined> = {};
  const perWeekdayLoad: Record<DayKey, number> = {
    sun: 0,
    mon: 0,
    tue: 0,
    wed: 0,
    thu: 0,
    fri: 0,
    sat: 0,
  };
  const perClientWeekdayLoad: Record<string, Record<DayKey, number>> = {};

  // Use the interleaved ISO list
  for (const iso of interleavedDates) {
    const date = parseISODateLocal(iso);
    const day = dayKeyFromDate(date) as DayKey; // "mon", "tue", ...
    const wk = weekKey(date);

    console.log("DAY →", iso, day);

    let dayAvail: TimeBlock[] = (sup.dailyAvail?.[day] || [])
      .map((b) => ({ start: b.start | 0, end: b.end | 0 }))
      .filter((b) => b.end > b.start)
      .sort((a, b) => a.start - b.start);

    if (runUnavailableDays.includes(iso)) dayAvail = [];
    const runOff = runOneOffUnavail[iso] || [];
    if (runOff.length) dayAvail = subtractBlocks(dayAvail, runOff);

    const lockedToday = (lockedByDate[iso] || []).map((b) => ({
      start: b.start,
      end: b.end,
    }));
    if (lockedToday.length) dayAvail = subtractBlocks(dayAvail, lockedToday);
    if (!dayAvail.length) continue;

    const candidates = req.clients.filter(
      (c) =>
        (remaining[c.id] || 0) > 0 &&
        (c.windows || []).some((w) => w.day === day)
    );
    if (!candidates.length) continue;

    console.log(
      "  sup blocks:",
      dayAvail.length,
      "candidates:",
      candidates.map((c) => c.id)
    );

    const slotMatch = (c: Client) => {
      const slots = c.preferredDaySlots || [];
      if (!slots.length) return 0;
      return slots.some((grp) => grp.includes(day)) ? 1 : 0;
    };

    let guard = 0;
    while (dayAvail.length && guard++ < 80) {
      const scored = candidates
        .map((c) => {
          const need = remaining[c.id] || 0;
          const slotPriority = slotMatch(c);

          // client + global weekday load (you already track these)
          perClientWeekdayLoad[c.id] ||= {
            sun: 0,
            mon: 0,
            tue: 0,
            wed: 0,
            thu: 0,
            fri: 0,
            sat: 0,
          };
          const clLoad = perClientWeekdayLoad[c.id][day] || 0;
          const globalLoad = perWeekdayLoad[day] || 0;

          // avoid back-to-back days for same client
          let b2bPenalty = 0;
          const last = lastPlacedISO[c.id];
          if (last) {
            const diffDays = Math.round(
              (date.getTime() - parseISO(DATE_FMT(parseISO(last))).getTime()) /
                (24 * 60 * 60 * 1000)
            );
            if (diffDays === 1) b2bPenalty = 1;
          }

          // scarcity boost — fewer distinct clinic days => higher priority
          const clinicDays =
            new Set((c.windows || []).map((w) => w.day)).size || 1;
          const scarcityBoost = 1 + 1.0 * (1 / clinicDays);

          // NEW: prefer clients that can make a 60-min block right now (when enabled)
          let sixtyBoost = 0;
          if (biasLonger) {
            const cBlocks = (c.windows || [])
              .filter((w) => w.day === day)
              .flatMap((w) => w.blocks || []);
            const feasNow = overlapBlocks(cBlocks, dayAvail)
              .map((b) => snapRangeToGrid(b, grid))
              .filter((b) => b.end > b.start);
            const maxLen = feasNow.length
              ? Math.max(...feasNow.map((b) => b.end - b.start))
              : 0;
            if (maxLen >= 60 && (remaining[c.id] || 0) >= 60) sixtyBoost = 1;
          }

          return {
            c,
            slotPriority,
            scarcityBoost,
            globalLoad,
            clLoad,
            b2bPenalty,
            need,
            sixtyBoost, // NEW
            jitter: (rand() >>> 0) / 0xffffffff,
          };
        })
        .sort((a, b) => {
          if (a.slotPriority !== b.slotPriority)
            return b.slotPriority - a.slotPriority;
          // NEW: take the 60-min opportunity when available
          if (a.sixtyBoost !== b.sixtyBoost) return b.sixtyBoost - a.sixtyBoost;
          // prefer fewer clinic days
          if (a.scarcityBoost !== b.scarcityBoost)
            return b.scarcityBoost - a.scarcityBoost;
          // spread your week overall
          if (a.globalLoad !== b.globalLoad) return a.globalLoad - b.globalLoad;
          // spread per-client weekday
          if (a.clLoad !== b.clLoad) return a.clLoad - b.clLoad;
          // avoid back-to-back
          if (a.b2bPenalty !== b.b2bPenalty) return a.b2bPenalty - b.b2bPenalty;
          // higher remaining need last
          if (a.need !== b.need) return b.need - a.need;
          return a.jitter - b.jitter;
        });

      let placed = false;

      for (const { c } of scored) {
        if (!dayAvail.length || (remaining[c.id] || 0) <= 0) continue;

        // per-week cap
        if (maxPerWeek[c.id] != null) {
          const used = weekCount[c.id]?.[wk] || 0;
          if (used >= (maxPerWeek[c.id] as number)) continue;
        }
        // per-day cap (NEW)
        if (maxPerDay[c.id] != null) {
          const usedD = dayCount[c.id]?.[iso] || 0;
          if (usedD >= (maxPerDay[c.id] as number)) continue;
        }

        const cBlocks = (c.windows || [])
          .filter((w) => w.day === day)
          .flatMap((w) => w.blocks || []);
        if (!cBlocks.length) continue;

        const feas = overlapBlocks(cBlocks, dayAvail)
          .map((b) => snapRangeToGrid(b, grid))
          .filter((b) => b.end > b.start)
          .sort((a, b) => a.start - b.start);

        if (!feas.length) continue;

        // Prefer a window that can host at least a min-session; else the largest window
        const minLen = Math.max(15, minSession[c.id] || 60);
        const feasBySize = [...feas].sort(
          (a, b) => b.end - b.start - (a.end - a.start)
        );
        const blk =
          feasBySize.find((b) => b.end - b.start >= minLen) ?? // can host full min session
          feasBySize[0]; // else largest

        const windowSize = blk.end - blk.start;
        const remainingM = Math.max(0, remaining[c.id] || 0);

        // Size “take” to fill as much as we reasonably can
        let take = Math.min(remainingM, windowSize);

        // --- NEW: stretch to 60m when biasLonger is on and we can
        if (biasLonger && take < 60) {
          if (windowSize >= 60 && (remaining[c.id] || 0) >= 60) {
            take = 60;
          }
        }

        // Defer tiny crumbs if client prefers no sub-hour and we can place later
        if (c.preferNoSubHour && take < 60) {
          const canDefer =
            remainingM >= 60 && clientHasFutureWindow(c, date, req);
          if (canDefer) continue;
        }

        // If we owe at least a min session and the window can hold it, place >= minLen
        if (remainingM >= minLen && windowSize >= minLen) {
          take = Math.min(Math.max(minLen, take), windowSize);
        } else if (remainingM >= minLen && windowSize < minLen) {
          // No window big enough today. If we can place later, defer rather than crumbs.
          if (clientHasFutureWindow(c, date, req)) continue;
          // Last resort today: place largest chunk we can.
          take = Math.floor(windowSize / grid) * grid;
          if (take < grid) continue;
        } else {
          // remainingM < minLen: place what fits (unless we already deferred above)
          take = Math.min(remainingM, windowSize);
        }

        // Snap to grid
        take = Math.floor(take / grid) * grid;
        if (take < grid) continue;

        const start = blk.start;
        const end = start + take;

        // merge with adjacent block (same client, same day)
        const existingIdx = scheduled.findIndex(
          (b) => b.date === iso && b.clientId === c.id && b.end === start
        );
        if (existingIdx >= 0) scheduled[existingIdx].end = end;
        else scheduled.push({ date: iso, clientId: c.id, start, end });

        remaining[c.id] = Math.max(0, remainingM - take);
        dayAvail = subtractBlocks(dayAvail, [{ start, end }]);

        perWeekdayLoad[day] = (perWeekdayLoad[day] || 0) + 1;
        perClientWeekdayLoad[c.id][day] =
          (perClientWeekdayLoad[c.id][day] || 0) + 1;
        lastPlacedISO[c.id] = iso;

        weekCount[c.id] ||= {};
        weekCount[c.id][wk] = (weekCount[c.id][wk] || 0) + 1;

        dayCount[c.id] ||= {};
        dayCount[c.id][iso] = (dayCount[c.id][iso] || 0) + 1;

        placed = true;
        break;
      }

      if (!placed) break;
    }
    // --- Fallback fill pass (relaxed): place as many valid blocks as fit today
    if (dayAvail.length) {
      const fillCandidates = req.clients.filter(
        (c) =>
          (remaining[c.id] || 0) > 0 &&
          (c.windows || []).some((w) => w.day === day)
      );

      let fillGuard = 0;
      while (dayAvail.length && fillGuard++ < 200) {
        let placedAny = false;

        for (const c of fillCandidates) {
          if (!dayAvail.length || (remaining[c.id] || 0) <= 0) continue;

          // per-week cap
          if (maxPerWeek[c.id] != null) {
            const usedW = weekCount[c.id]?.[wk] || 0;
            if (usedW >= (maxPerWeek[c.id] as number)) continue;
          }
          // per-day cap
          if (maxPerDay[c.id] != null) {
            const usedD = dayCount[c.id]?.[iso] || 0;
            if (usedD >= (maxPerDay[c.id] as number)) continue;
          }

          // Overlap with today's supervisor availability (no slot preference here)
          const cBlocks = (c.windows || [])
            .filter((w) => w.day === day)
            .flatMap((w) => w.blocks || []);
          if (!cBlocks.length) continue;

          const feas = overlapBlocks(cBlocks, dayAvail)
            .map((b) => snapRangeToGrid(b, grid))
            .filter((b) => b && b.end > b.start)
            .sort((a, b) => a.start - b.start) as TimeBlock[];
          if (!feas.length) continue;

          const blk = feas[0];
          const windowSize = blk.end - blk.start;
          const minLen = Math.max(15, minSession[c.id] || 60);

          let take = Math.min(remaining[c.id], windowSize);

          // 1) Ensure at least the client's minimum session if the window supports it
          if (take < minLen) {
            if (windowSize >= minLen) {
              take = minLen;
            } else {
              continue; // window too small to host even one minimum session
            }
          }

          // 2) Honor "no sub-hour" preference AFTER the min-length bump.
          //    If still < 60, try to bump to 60 if the window can fit it.
          if (c.preferNoSubHour && take < 60) {
            if (windowSize >= 60) {
              take = 60;
            } else {
              continue;
            }
          }

          // 3) Snap to grid
          take = Math.floor(take / grid) * grid;
          if (take < grid) continue;

          const start = blk.start;
          const end = start + take;

          scheduled.push({ date: iso, clientId: c.id, start, end });
          console.log("PLACED", iso, c.id, `${toHHMM(start)}–${toHHMM(end)}`);
          remaining[c.id] = Math.max(0, remaining[c.id] - take);
          dayAvail = subtractBlocks(dayAvail, [{ start, end }]);

          // update loads/counters
          perWeekdayLoad[day] = (perWeekdayLoad[day] || 0) + 1;
          perClientWeekdayLoad[c.id] ||= {
            sun: 0,
            mon: 0,
            tue: 0,
            wed: 0,
            thu: 0,
            fri: 0,
            sat: 0,
          };
          perClientWeekdayLoad[c.id][day] =
            (perClientWeekdayLoad[c.id][day] || 0) + 1;
          lastPlacedISO[c.id] = iso;

          weekCount[c.id] ||= {};
          weekCount[c.id][wk] = (weekCount[c.id][wk] || 0) + 1;

          dayCount[c.id] ||= {};
          dayCount[c.id][iso] = (dayCount[c.id][iso] || 0) + 1;

          placedAny = true;
          if (!dayAvail.length) break; // no more room today
        }

        if (!placedAny) break; // nothing else fits today
      }
    }
    // --- Per-day summary (debug): target vs placed vs remaining
    try {
      const byClientPlaced: Record<string, number> = {};
      for (const b of scheduled) {
        if (b.date !== iso) continue;
        byClientPlaced[b.clientId] =
          (byClientPlaced[b.clientId] || 0) + (b.end - b.start);
      }
      const summary = req.clients.map((c) => ({
        client: c.id,
        targetMin: targetInit[c.id] || 0,
        placedTodayMin: byClientPlaced[c.id] || 0,
        remainingMin: remaining[c.id] || 0,
      }));
      console.log(
        `SUMMARY ${iso} (${day.toUpperCase()}):`,
        summary
          .map(
            (s) =>
              `${s.client}: tgt=${(s.targetMin / 60).toFixed(2)}h, today=${(
                s.placedTodayMin / 60
              ).toFixed(2)}h, rem=${(s.remainingMin / 60).toFixed(2)}h`
          )
          .join(" | ")
      );
    } catch {}
  }

  // Step 3: consolidation pass (merges sub-hour crumbs if possible)
  const consolidated = consolidateShortSessions(req, scheduled, grid);
  return consolidated;
}

/** Post-process: merge tiny gaps and stretch short sessions where possible. */
function polishSchedule(
  req: ScheduleRequest,
  blocks: ScheduledBlock[],
  lockedList: ScheduledBlock[] = [],
  opts?: { grid?: number; minBlock?: number }
): ScheduledBlock[] {
  const grid = Math.max(
    5,
    opts?.grid ?? Math.max(5, req.supervisor.roundingMinutes || 15)
  );
  const minBlock = opts?.minBlock ?? 45; // target minimum length for a single block

  const lockKey = (b: ScheduledBlock) =>
    `${b.date}|${b.clientId}|${b.start}|${b.end}`;
  const lockedKeys = new Set(lockedList.map(lockKey));

  const DATE = (iso: string) => parseISODateLocal(iso);
  const dayKeyFromISO = (iso: string) => dayKeyFromDate(DATE(iso));

  // Rebuild per-day lists (copy, sorted)
  const byDate: Record<string, ScheduledBlock[]> = {};
  for (const b of blocks) {
    (byDate[b.date] ||= []).push({ ...b });
  }
  for (const d of Object.keys(byDate)) {
    byDate[d].sort((a, b) => a.start - b.start);
  }

  // Helper: supervisor free slots for a date after subtracting all scheduled blocks
  const supDayAvail = (iso: string): TimeBlock[] => {
    const day = dayKeyFromISO(iso);
    let avail = (req.supervisor.dailyAvail?.[day] || [])
      .map((w) => w.blocks || [])
      .flat()
      .map((b) => ({ start: b.start | 0, end: b.end | 0 }))
      .filter((b) => b.end > b.start)
      .sort((a, b) => a.start - b.start);

    // closed day?
    if ((req.supervisor.unavailableDays || []).includes(iso)) return [];

    // one-off unavailability
    const off = req.supervisor.oneOffUnavail?.[iso] || [];
    if (off.length) avail = subtractBlocks(avail, off);

    // subtract all scheduled (current day's) blocks
    const todays = byDate[iso] || [];
    if (todays.length) {
      const taken = todays.map((b) => ({ start: b.start, end: b.end }));
      avail = subtractBlocks(avail, taken);
    }

    return avail;
  };

  // Pass A: merge adjacent same-client fragments separated by ≤ grid (unlocked only)
  for (const iso of Object.keys(byDate)) {
    const arr = byDate[iso];
    const merged: ScheduledBlock[] = [];
    let i = 0;
    while (i < arr.length) {
      let cur = arr[i];
      i++;
      while (
        i < arr.length &&
        cur.clientId === arr[i].clientId &&
        !lockedKeys.has(lockKey(cur)) &&
        !lockedKeys.has(lockKey(arr[i])) &&
        arr[i].start - cur.end <= grid
      ) {
        // Merge into cur
        cur = { ...cur, end: Math.max(cur.end, arr[i].end) };
        i++;
      }
      merged.push(cur);
    }
    byDate[iso] = merged.sort((a, b) => a.start - b.start);
  }

  // Pass B: stretch short sessions rightward into free space (unlocked only)
  for (const iso of Object.keys(byDate)) {
    const arr = byDate[iso];
    if (!arr.length) continue;

    // recompute free space once per date (updates as we extend)
    let free = supDayAvail(iso);

    for (let idx = 0; idx < arr.length; idx++) {
      const b = arr[idx];
      if (lockedKeys.has(lockKey(b))) continue;

      const len = b.end - b.start;
      if (len >= minBlock) continue; // already good

      const need = minBlock - len;

      // find a free segment that starts <= block.end and ends after it (right-extend)
      let extendBy = 0;
      for (const f of free) {
        if (f.start <= b.end && f.end > b.end) {
          extendBy = Math.min(need, f.end - b.end);
          break;
        }
      }
      if (extendBy > 0) {
        // snap to grid
        extendBy = Math.floor(extendBy / grid) * grid;
        if (extendBy >= grid) {
          // perform extension
          const newEnd = b.end + extendBy;
          // ensure we don't overlap the next block
          const next = arr[idx + 1];
          if (!next || newEnd <= next.start) {
            // mutably extend
            b.end = newEnd;
            // update free map: remove the consumed slice
            free = subtractBlocks(free, [
              { start: b.end - extendBy, end: b.end },
            ]);
          }
        }
      }
    }
  }

  // Flatten back out
  const out: ScheduledBlock[] = [];
  for (const iso of Object.keys(byDate)) out.push(...byDate[iso]);
  // keep stable sort: date then time
  out.sort((a, b) =>
    a.date === b.date ? a.start - b.start : a.date.localeCompare(b.date)
  );
  return out;
}

/* =======================
   CSV / ICS Export
======================= */

function exportScheduleCSV(
  blocks: ScheduledBlock[],
  getColorForClient: (id: string) => string
) {
  const header = "Date,Client,Start,End,Start24,End24,Minutes,Color";
  const rows = blocks
    .slice()
    .sort((a, b) =>
      a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1
    )
    .map((b) => {
      const mins = b.end - b.start;
      return [
        b.date,
        b.clientId,
        toHHMM(b.start),
        toHHMM(b.end),
        to24(b.start),
        to24(b.end),
        String(mins),
        getColorForClient(b.clientId),
      ]
        .map((x) => `"${String(x).replace(/"/g, '""')}"`)
        .join(",");
    });
  const csv = [header, ...rows].join("\n");
  downloadText(`schedule_${Date.now()}.csv`, csv);
}

// Simple ICS (floating local time)
function exportScheduleICS(blocks: ScheduledBlock[]) {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//ABA Scheduler//EN",
  ];
  const toICSLocal = (iso: string, mins: number) => {
    const d = parseISO(iso);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    d.setHours(h, m, 0, 0);
    const Y = d.getFullYear();
    const Mo = pad2(d.getMonth() + 1);
    const Da = pad2(d.getDate());
    const Ho = pad2(d.getHours());
    const Mi = pad2(d.getMinutes());
    const Se = "00";
    return `${Y}${Mo}${Da}T${Ho}${Mi}${Se}`;
  };
  blocks
    .slice()
    .sort((a, b) =>
      a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1
    )
    .forEach((b, i) => {
      const uid = `${b.clientId}-${b.date}-${b.start}-${b.end}-${i}@aba-scheduler`;
      lines.push(
        "BEGIN:VEVENT",
        `UID:${uid}`,
        `DTSTART:${toICSLocal(b.date, b.start)}`,
        `DTEND:${toICSLocal(b.date, b.end)}`,
        `SUMMARY:${b.clientId} supervision`,
        `DESCRIPTION:${b.clientId} ${toHHMM(b.start)}–${toHHMM(b.end)}`,
        "END:VEVENT"
      );
    });
  lines.push("END:VCALENDAR");
  downloadText(`schedule_${Date.now()}.ics`, lines.join("\n"));
}

/* =======================
   App
======================= */

export default function App() {
  const [tab, setTab] = useState<"inputs" | "clients" | "saved" | "schedule">(
    "schedule"
  );
  const [viewMode, setViewMode] = useState<"list" | "calendar">("list");

  const [user, setUser] = useState<AppUser>(null);
  useEffect(() => {
    return onAuthStateChanged(auth, (u) => {
      if (!u) setUser(null);
      else
        setUser({
          uid: u.uid,
          displayName: u.displayName,
          email: u.email,
          photoURL: u.photoURL,
        });
    });
  }, []);

  const [supervisor, setSupervisor] = useState<Supervisor>({
    roundingMinutes: 15,
    dailyAvail: {
      sun: [],
      mon: [],
      tue: [],
      wed: [],
      thu: [],
      fri: [],
      sat: [],
    },
  });

  const [clients, setClients] = useState<Client[]>([]);
  const [startDate, setStartDate] = useState<string>(() => {
    const today = new Date();
    return DATE_FMT(today);
  });

  const [endDate, setEndDate] = useState<string>(() => {
    const today = new Date();
    const eD = addDays(today, 6);
    return DATE_FMT(eD);
  });
  const [targetOverrideMin, setTargetOverrideMin] = useState<
    Record<string, number>
  >({});
  const [runUnavailableDays, setRunUnavailableDays] = useState<string[]>([]);
  const [runOneOffUnavail, setRunOneOffUnavail] = useState<
    Record<string, TimeBlock[]>
  >({});

  const [req, setReq] = useState<ScheduleRequest | null>(null);
  const [shuffleNonce, setShuffleNonce] = useState(1);
  const [locked, setLocked] = useState<ScheduledBlock[]>([]);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Client | null>(null);

  const [doPolish, setDoPolish] = useState(false);

  const [doBiasLonger, setDoBiasLonger] = useState(false);

  function startEdit(c: Client) {
    setEditingId(c.id);
    setDraft(JSON.parse(JSON.stringify(c))); // deep copy
  }
  function cancelEdit() {
    setEditingId(null);
    setDraft(null);
  }
  function saveEdit() {
    if (!draft) return;
    setClients((prev) => prev.map((c) => (c.id === editingId ? draft : c)));
    setEditingId(null);
    setDraft(null);
  }

  type SB = ScheduledBlock;
  const lockKey = (b: SB) => `${b.date}|${b.clientId}|${b.start}|${b.end}`;

  const isLocked = React.useCallback(
    (b: SB) => locked.some((x) => lockKey(x) === lockKey(b)),
    [locked]
  );

  const toggleLock = React.useCallback((b: SB) => {
    const k = lockKey(b);
    setLocked((prev) => {
      const exists = prev.some((x) => lockKey(x) === k);
      return exists
        ? prev.filter((x) => lockKey(x) !== k)
        : [...prev, { ...b }];
    });
  }, []);

  const lockAllForThese = React.useCallback((blocks: SB[]) => {
    setLocked((prev) => {
      const next = new Map(prev.map((x) => [lockKey(x), x]));
      for (const b of blocks) next.set(lockKey(b), { ...b });
      return Array.from(next.values());
    });
  }, []);

  const unlockAllForThese = React.useCallback((blocks: SB[]) => {
    const remove = new Set(blocks.map(lockKey));
    setLocked((prev) => prev.filter((x) => !remove.has(lockKey(x))));
  }, []);

  const [banner, setBanner] = useState<string | null>(null);
  const showBanner = (msg: string, ms = 1600) => {
    setBanner(msg);
    window.setTimeout(() => setBanner(null), ms);
  };
  const [cloudStatus, setCloudStatus] = useState<"idle" | "saving" | "saved">(
    "idle"
  );
  const [genError, setGenError] = useState<string | null>(null);

  // local autosave (presets)
  const LS_KEY = "aba-scheduler-v4";
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.clients)) setClients(parsed.clients);
        if (parsed?.supervisor) setSupervisor(parsed.supervisor);
      }
    } catch (e) {
      console.error("Local load failed:", e);
    }
    setHydrated(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!hydrated) return;
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ clients, supervisor }));
    } catch {}
  }, [hydrated, clients, supervisor]);

  // === BEGIN saveToCloud (REPLACEMENT) ===
  async function saveToCloud() {
    if (!user?.uid) {
      showBanner("Sign in first");
      return;
    }
    try {
      // 1) normalize clients so Firestore sees no nested arrays
      const payloadClients = clients.map((c) => ({
        ...c,
        // Wrap string[] as {days:string[]} to avoid nested arrays (string[][] not allowed)
        preferredDaySlots: (c.preferredDaySlots || []).map((days) => ({
          days,
        })),
      }));

      // 2) build payload
      const payload = {
        clients: payloadClients,
        supervisor, // include anything else you store
      };

      // 3) save (merge so we don't blow away other fields)
      const ref = doc(db, "schedulers", user.uid);
      await setDoc(ref, payload, { merge: true });

      console.log("SAVE →", { path: ref.path, clients: payloadClients.length });
      showBanner("Saved to cloud ✅");
    } catch (e: any) {
      console.error("saveToCloud error:", e);
      showBanner(`Save failed: ${e?.code || ""} ${e?.message || e}`);
    }
  }
  // === BEGIN loadFromCloud (REPLACEMENT) ===
  async function loadFromCloud() {
    if (!user?.uid) {
      showBanner("Sign in first");
      return;
    }
    try {
      const ref = doc(db, "schedulers", user.uid);
      const snap = await getDoc(ref);
      console.log("LOAD ←", { path: ref.path, exists: snap.exists() });
      if (!snap.exists()) {
        showBanner("No cloud data found yet for this account.");
        return;
      }

      const data = snap.data() || {};

      // Unwrap preferredDaySlots back to string[][]
      const loadedClients = (data.clients || []).map((c: any) => {
        const raw = c?.preferredDaySlots;
        let slots: string[][] = [];
        if (Array.isArray(raw)) {
          slots = raw.map((entry: any) =>
            // accept both shapes for backward compatibility
            Array.isArray(entry) ? entry : entry?.days || []
          );
        }
        return {
          ...c,
          preferredDaySlots: slots,
        };
      });

      console.log("LOAD data", {
        keys: Object.keys(data),
        clientsCount: loadedClients.length,
        sampleSlotsShape:
          loadedClients[0]?.preferredDaySlots &&
          Array.isArray(loadedClients[0].preferredDaySlots[0])
            ? "string[][]"
            : "unknown",
      });

      setClients(loadedClients);
      setSupervisor(data.supervisor || null);
      showBanner("Loaded from cloud ✅");
    } catch (e: any) {
      console.error("loadFromCloud error:", e);
      showBanner(`Load failed: ${e?.code || ""} ${e?.message || e}`);
    }
  }
  // === END loadFromCloud (REPLACEMENT) ===
  useEffect(() => {
    if (cloudStatus === "saved") {
      const t = setTimeout(() => setCloudStatus("idle"), 2500);
      return () => clearTimeout(t);
    }
  }, [cloudStatus]);

  function onGenerateClick() {
    try {
      // Build a fresh, immutable request from current state
      const request: ScheduleRequest = {
        startDate,
        endDate,
        clients: JSON.parse(JSON.stringify(clients)),
        supervisor: JSON.parse(JSON.stringify(supervisor)),
      };

      // Save it and bump the shuffle seed
      setReq(request);
      setShuffleNonce(Math.floor(Math.random() * 1e9));

      // Move user to schedule tab
      setTab("schedule");

      // Clear any previous error
      setGenError?.(null);
    } catch (err: any) {
      setGenError(err?.message || String(err));
    }
  }

  // Build the schedule (deterministic unless you change shuffleNonce)
  const schedule = useMemo(() => {
    if (!req) return [];
    try {
      const map = (req as any).__targetMap as
        | Record<string, number>
        | undefined;
      const rd = (req as any).__runUnavailableDays as string[] | undefined;
      const ro = (req as any).__runOneOffUnavail as
        | Record<string, TimeBlock[]>
        | undefined;

      const base = generateSchedule(
        req,
        shuffleNonce,
        locked,
        map,
        rd,
        ro,
        doBiasLonger
      );

      // IMPORTANT: this is the schedule the UI uses everywhere else
      return doPolish ? cleanUpSchedule(base, locked) : base;
    } catch (err) {
      console.error("generateSchedule failed:", err);
      return [];
    }
  }, [req, shuffleNonce, locked, doPolish, doBiasLonger]); // ← include doPolish!

  // Presentational layer: optionally show a “polished” version of the schedule.
  const viewSchedule = useMemo(() => {
    if (!req) return [];
    return doPolish
      ? polishSchedule(req, schedule, locked, { minBlock: 45 })
      : schedule;
  }, [doPolish, req, schedule, locked]);

  // weeks + lock helpers
  const weeks = useMemo(() => {
    const byWeek: Record<string, ScheduledBlock[]> = {};
    for (const b of schedule) {
      const d = parseISO(b.date);
      const wkStart = new Date(d);
      wkStart.setDate(d.getDate() - ((d.getDay() + 6) % 7));
      const wkISO = DATE_FMT(wkStart);
      (byWeek[wkISO] ||= []).push(b);
    }
    return Object.keys(byWeek)
      .sort()
      .map((wk) => ({
        wk,
        blocks: byWeek[wk].sort((a, b) =>
          a.date === b.date ? a.start - b.start : a.date < b.date ? -1 : 1
        ),
      }));
  }, [viewSchedule]);

  const getColorForClient = (id: string) =>
    clients.find((c) => c.id === id)?.color || "#e5e7eb";

  /* =========================
   UI
========================= */

  const styles = {
    card: {
      border: "1px solid #e5e7eb",
      borderRadius: 12,
      padding: 12,
      marginBottom: 12,
    },

    btn: {
      padding: "8px 12px",
      border: "1px solid #e5e7eb",
      borderRadius: 10,
      background: "#fff",
    },

    // NEW: dynamic style function for lock button (call: styles.lockBtn(lockedNow))
    lockBtn: (locked: boolean) => ({
      padding: "2px 6px",
      borderRadius: 6,
      border: "1px solid",
      borderColor: locked ? "#16a34a" : "#d1d5db", // green if locked, gray if not
      background: locked ? "#dcfce7" : "#f9fafb",
      color: locked ? "#166534" : "#374151",
      cursor: "pointer",
      fontSize: 12,
    }),
  } as const;

  const TabBtn = (p: {
    id: "inputs" | "clients" | "saved" | "schedule";
    label: string;
  }) => (
    <button
      type="button"
      onClick={() => setTab(p.id)}
      style={{
        padding: "10px 16px",
        border: "1px solid #e5e7eb",
        borderRadius: 12,
        background: tab === p.id ? "#635bff" : "#fff",
        color: tab === p.id ? "#fff" : "#111827",
        fontWeight: 700,
      }}
    >
      {p.label}
    </button>
  );

  return (
    <div
      style={{
        padding: 16,
        maxWidth: 1000,
        margin: "0 auto",
        fontFamily: "ui-sans-serif, system-ui",
      }}
    >
      {/* Header + auth */}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 8,
        }}
      >
        <h1 style={{ margin: 0 }}>ABA Supervision Scheduler</h1>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {user ? (
            <>
              <span style={{ fontSize: 14 }}>
                Hi, {user.displayName || user.email}
              </span>
              <button
                type="button"
                style={styles.btn}
                onClick={() => signOut(auth)}
              >
                Sign out
              </button>
            </>
          ) : (
            <button
              type="button"
              style={styles.btn}
              onClick={() => signInWithPopup(auth, googleProvider)}
            >
              Sign in with Google
            </button>
          )}
        </div>
      </div>

      {user && (
        <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
          <button type="button" style={styles.btn2} onClick={loadFromCloud}>
            Load my data
          </button>
          <button
            type="button"
            style={styles.btn2}
            onClick={saveToCloud}
            disabled={cloudStatus === "saving"}
            title={!user ? "Sign in first" : ""}
          >
            {cloudStatus === "saving"
              ? "Saving…"
              : cloudStatus === "saved"
              ? "Saved ✓"
              : "Save to cloud"}
          </button>
        </div>
      )}

      {/* tabs */}
      <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
        <TabBtn id="inputs" label="Supervisor & Presets" />
        <TabBtn id="clients" label="Add Clients (Form)" />
        <TabBtn id="saved" label="Saved Clients" />
        <TabBtn id="schedule" label="Schedule" />
      </div>

      {/* Supervisor weekly availability */}
      {tab === "inputs" && (
        <div style={styles.card}>
          <h2>Supervisor weekly availability</h2>
          <div
            style={{
              display: "grid",
              gap: 10,
              gridTemplateColumns: "repeat(7, minmax(0,1fr))",
            }}
          >
            {DAYS.map((d) => (
              <div
                key={d}
                style={{
                  border: "1px solid #e5e7eb",
                  borderRadius: 8,
                  padding: 8,
                }}
              >
                <b style={{ textTransform: "uppercase" }}>{d}</b>
                <SmallBlockEditor
                  blocks={supervisor.dailyAvail[d] || []}
                  onChange={(blk) =>
                    setSupervisor((s) => ({
                      ...s,
                      dailyAvail: { ...s.dailyAvail, [d]: blk },
                    }))
                  }
                />
              </div>
            ))}
          </div>
          <div style={{ marginTop: 12 }}>
            <label>Rounding (minutes): </label>
            <input
              type="number"
              value={supervisor.roundingMinutes ?? 15}
              onChange={(e) =>
                setSupervisor((s) => ({
                  ...s,
                  roundingMinutes: Math.max(5, Number(e.target.value) || 15),
                }))
              }
              style={{ width: 80 }}
            />
          </div>
        </div>
      )}

      {/* Add Clients */}
      {tab === "clients" && (
        <ClientForm
          onAdd={(c) => {
            setClients((prev) => prev.concat(c));
            setTab("saved");
            showBanner("Client added");
          }}
        />
      )}

      {/* Saved Clients */}
      {tab === "saved" && (
        <div style={styles.card}>
          <h2>Saved Clients</h2>
          {clients.length === 0 ? (
            <div>No clients yet. Add one in the “Add Clients (Form)” tab.</div>
          ) : (
            clients.map((c) => {
              const isEditing = editingId === c.id;
              if (!isEditing) {
                return (
                  <div
                    key={c.id}
                    style={{
                      border: "1px solid #e5e7eb",
                      borderRadius: 8,
                      padding: 10,
                      marginBottom: 8,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                      }}
                    >
                      <div>
                        <b>{c.id}</b>{" "}
                        <span style={{ opacity: 0.7 }}>
                          (min {c.minSessionMins || 60}m)
                        </span>
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button type="button" onClick={() => startEdit(c)}>
                          Edit
                        </button>
                        <button
                          type="button"
                          onClick={() => removeClient(c.id)}
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                    <div style={{ fontSize: 12, opacity: 0.75 }}>
                      Sup%: {c.supPercent || 10} • Max/week:{" "}
                      {c.maxSessionsPerWeek ?? "—"}
                    </div>
                  </div>
                );
              }

              // editing mode
              return (
                <div
                  key={c.id}
                  style={{
                    border: "1px solid #c7d2fe",
                    background: "#eef2ff",
                    borderRadius: 8,
                    padding: 10,
                    marginBottom: 8,
                  }}
                >
                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "160px 1fr 1fr",
                      gap: 8,
                    }}
                  >
                    <label>
                      ID
                      <input
                        value={draft!.id}
                        onChange={(e) =>
                          setDraft({ ...draft!, id: e.target.value.trim() })
                        }
                      />
                    </label>
                    <label>
                      Sup % (default)
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={draft!.supPercent ?? 10}
                        onChange={(e) =>
                          setDraft({
                            ...draft!,
                            supPercent: Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Min session (mins)
                      <input
                        type="number"
                        min={15}
                        step={5}
                        value={draft!.minSessionMins ?? 60}
                        onChange={(e) =>
                          setDraft({
                            ...draft!,
                            minSessionMins: Number(e.target.value),
                          })
                        }
                      />
                    </label>

                    <label>
                      Max sessions / week
                      <input
                        type="number"
                        min={0}
                        value={draft!.maxSessionsPerWeek ?? ""}
                        onChange={(e) =>
                          setDraft({
                            ...draft!,
                            maxSessionsPerWeek:
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Max sessions / day
                      <input
                        type="number"
                        min={0}
                        value={draft!.maxSessionsPerDay ?? ""}
                        onChange={(e) =>
                          setDraft({
                            ...draft!,
                            maxSessionsPerDay:
                              e.target.value === ""
                                ? null
                                : Number(e.target.value),
                          })
                        }
                      />
                    </label>
                    <label>
                      Color
                      <input
                        value={draft!.color || "#e5e7eb"}
                        onChange={(e) =>
                          setDraft({ ...draft!, color: e.target.value })
                        }
                      />
                    </label>
                  </div>

                  {/* weekday window editor */}
                  <div
                    style={{
                      marginTop: 10,
                      display: "grid",
                      gridTemplateColumns: "repeat(7, 1fr)",
                      gap: 6,
                      fontSize: 12,
                    }}
                  >
                    {(
                      [
                        "mon",
                        "tue",
                        "wed",
                        "thu",
                        "fri",
                        "sat",
                        "sun",
                      ] as DayKey[]
                    ).map((dk) => {
                      const text = (draft!.windows || [])
                        .filter((w) => w.day === dk)
                        .flatMap((w) => w.blocks || [])
                        .map((b) => `${toHHMM(b.start)} - ${toHHMM(b.end)}`)
                        .join(", ");
                      return (
                        <div key={dk}>
                          <div style={{ fontWeight: 700, marginBottom: 4 }}>
                            {dk.toUpperCase()}
                          </div>
                          <input
                            placeholder="e.g. 2:30 pm - 5:30 pm, 8:00-9:00"
                            value={text}
                            onChange={(e) => {
                              const blocks = parseWindowString(e.target.value);
                              const others = (draft!.windows || []).filter(
                                (w) => w.day !== dk
                              );
                              setDraft({
                                ...draft!,
                                windows: [...others, { day: dk, blocks }],
                              });
                            }}
                          />
                        </div>
                      );
                    })}
                  </div>

                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    <button type="button" onClick={saveEdit}>
                      Save
                    </button>
                    <button type="button" onClick={cancelEdit}>
                      Cancel
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* Schedule */}
      {tab === "schedule" && (
        <div style={styles.card}>
          {/* Date range & run inputs */}
          <div
            style={{
              display: "flex",
              gap: 12,
              alignItems: "flex-end",
              marginBottom: 12,
              flexWrap: "wrap",
            }}
          >
            <div>
              <label style={{ fontSize: 12, display: "block" }}>
                Start date
              </label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>
            <div>
              <label style={{ fontSize: 12, display: "block" }}>End date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>
            <button
              type="button"
              style={styles.btn2}
              onClick={onGenerateClick}
              title={
                req
                  ? "Shuffle existing schedule"
                  : "Generate using the current settings"
              }
            >
              {req ? "Shuffle" : "Generate Schedule"}
            </button>
            <button
              type="button"
              style={styles.btn}
              onClick={() => setTargetOverrideMin({})}
            >
              Clear overrides
            </button>
            <button
              type="button"
              style={{ ...styles.btn, marginLeft: "auto" }}
              onClick={() =>
                setViewMode((m) => (m === "list" ? "calendar" : "list"))
              }
            >
              View: {viewMode === "list" ? "Calendar" : "List"}
            </button>
          </div>

          {/* Overrides */}
          <div
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 10,
              padding: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Per-run supervision hours
            </div>
            <div style={{ fontSize: 12, color: "#4b5563", marginBottom: 8 }}>
              Leave blank to use <b>supervision %</b> × client windows within{" "}
              {startDate} → {endDate}.
            </div>
            {clients.length === 0 ? (
              <div>No clients yet.</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr
                    style={{
                      textAlign: "left",
                      borderBottom: "1px solid #e5e7eb",
                    }}
                  >
                    <th style={{ padding: "6px 4px" }}>Client</th>
                    <th style={{ padding: "6px 4px" }}>Default (from %)</th>
                    <th style={{ padding: "6px 4px" }}>Override (hours)</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {clients.map((c) => {
                    const defMin = defaultTargetMinForClientInRange(
                      c,
                      startDate,
                      endDate
                    );
                    const overrideMin = targetOverrideMin[c.id];
                    return (
                      <tr
                        key={c.id}
                        style={{ borderBottom: "1px solid #f3f4f6" }}
                      >
                        <td style={{ padding: "8px 4px" }}>
                          <b>{c.id}</b>
                          <div style={{ fontSize: 12, color: "#6b7280" }}>
                            {c.supPercent}% → {hh(defMin)}
                          </div>
                        </td>
                        <td style={{ padding: "8px 4px" }}>{hh(defMin)}</td>
                        <td style={{ padding: "8px 4px" }}>
                          <input
                            type="text"
                            inputMode="decimal"
                            placeholder="e.g. 1.5"
                            style={{ width: 100 }}
                            value={
                              overrideMin != null
                                ? (overrideMin / 60).toString()
                                : ""
                            }
                            onChange={(e) => {
                              const m = parseHoursToMin(e.target.value);
                              setTargetOverrideMin((prev) => {
                                const next = { ...prev };
                                if (m == null) delete next[c.id];
                                else next[c.id] = m;
                                return next;
                              });
                            }}
                          />
                        </td>
                        <td style={{ padding: "8px 4px" }}>
                          {overrideMin != null && (
                            <button
                              type="button"
                              style={styles.btn}
                              onClick={() =>
                                setTargetOverrideMin((prev) => {
                                  const next = { ...prev };
                                  delete next[c.id];
                                  return next;
                                })
                              }
                            >
                              Clear
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Run-specific closed days / exclusions */}
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "1fr 1fr",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                padding: 10,
              }}
            >
              <b>Closed days (this run)</b>
              <ClosedDaysEditor
                days={runUnavailableDays}
                onChange={setRunUnavailableDays}
              />
            </div>
            <div
              style={{
                border: "1px solid #e5e7eb",
                borderRadius: 10,
                padding: 10,
              }}
            >
              <b>Specific date/time exclusions (this run)</b>
              <OneOffEditor
                data={runOneOffUnavail}
                onChange={setRunOneOffUnavail}
              />
            </div>
          </div>

          {/* Utilization */}
          <div
            style={{
              background: "#f9fafb",
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: 10,
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 6 }}>
              Utilization overview
            </div>
            {clients.map((c) => {
              const map = (req as any)?.__targetMap as
                | Record<string, number>
                | undefined;
              const target =
                map?.[c.id] ??
                defaultTargetMinForClientInRange(c, startDate, endDate);
              const sched = schedule
                .filter((b) => b.clientId === c.id)
                .reduce((sum, b) => sum + (b.end - b.start), 0);
              const rem = Math.max(0, target - sched);
              return (
                <div key={c.id} style={{ display: "flex", gap: 10 }}>
                  <b>{c.id}</b>
                  <span>Target: {hh(target)}</span>
                  <span>Scheduled: {hh(sched)}</span>
                  <span>Remaining: {hh(rem)}</span>
                </div>
              );
            })}
          </div>

          {/* View modes */}
          {viewMode === "list" ? (
            <>
              {weeks.map(({ wk, blocks }) => (
                <div key={wk} style={{ marginBottom: 12 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      marginBottom: 6,
                    }}
                  >
                    <div style={{ fontWeight: 700 }}>Week of {wk}</div>
                    <div>
                      <button
                        type="button"
                        style={styles.btn}
                        onClick={() => lockAllForThese(blocks)}
                      >
                        🔒 Lock week
                      </button>
                      <button
                        type="button"
                        style={{ ...styles.btn, marginLeft: 8 }}
                        onClick={() => unlockAllForThese(blocks)}
                      >
                        🔓 Unlock week
                      </button>
                    </div>
                  </div>
                  {blocks.map((b) => {
                    const lockedNow = isLocked(b);
                    return (
                      <div
                        key={`${b.date}|${b.clientId}|${b.start}|${b.end}`}
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          alignItems: "center",
                          border: `1px solid ${getColorForClient(b.clientId)}`,
                          borderRadius: 8,
                          padding: "6px 10px",
                          marginBottom: 6,
                          background: lockedNow ? "#f5f3ff" : "#fff",
                        }}
                      >
                        <div
                          style={{
                            display: "flex",
                            gap: 8,
                            alignItems: "center",
                          }}
                        >
                          <b>{b.date}</b>
                          <span style={{ fontWeight: 700 }}>{b.clientId}</span>
                          <span>
                            {toHHMM(b.start)}–{toHHMM(b.end)}
                          </span>
                        </div>
                        <button
                          type="button"
                          style={styles.lockBtn(lockedNow)}
                          onClick={() => toggleLock(b)}
                          title={
                            lockedNow
                              ? "Unlock this session"
                              : "Lock this session"
                          }
                        >
                          {lockedNow ? "🔒 Locked" : "🔓 Lock"}
                        </button>
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          ) : (
            <CalendarWeeks
              weeks={weeks}
              getColor={getColorForClient}
              onToggleLock={toggleLock}
              isLocked={isLocked}
            />
          )}

          {/* Bottom controls */}
          <div
            style={{ marginTop: 12, display: "flex", gap: 8, flexWrap: "wrap" }}
          >
            <button
              type="button"
              style={styles.btn}
              onClick={() => exportScheduleCSV(viewSchedule, getColorForClient)}
              title="Download CSV of current schedule"
            >
              Export CSV
            </button>
            <button
              type="button"
              style={styles.btn}
              onClick={() => exportScheduleICS(viewSchedule)}
              title="Download ICS calendar file"
            >
              Export ICS
            </button>
            {schedule.length > 0 && (
              <button
                type="button"
                onClick={() => setDoPolish((v) => !v)}
                title="Merge tiny gaps and stretch short sessions where possible (respects locked blocks)"
                style={styles.btn2}
              >
                {doPolish ? "Undo clean-up" : "Clean up schedule"}
              </button>
            )}
            {schedule.length > 0 && (
              <button
                type="button"
                onClick={() => setDoBiasLonger((v) => !v)}
                title="Prefer ~60+ min sessions when a window allows (keeps caps/locks)"
                style={styles.btn2}
              >
                {doBiasLonger ? "Bias off" : "Bias toward 60-min"}
              </button>
            )}
          </div>

          {genError && (
            <div style={{ marginTop: 10, color: "#b91c1c" }}>
              <b>Error:</b> {genError}
            </div>
          )}
        </div>
      )}

      {/* toast banner */}
      {banner && (
        <div
          style={{
            position: "fixed",
            top: 12,
            right: 12,
            background: "#111827",
            color: "#fff",
            padding: "8px 12px",
            borderRadius: 8,
            boxShadow: "0 6px 20px rgba(0,0,0,.25)",
            zIndex: 9999,
          }}
        >
          {banner}
        </div>
      )}
    </div>
  );
}

/* =======================
   Small editors & forms
======================= */

function SmallBlockEditor({
  blocks,
  onChange,
}: {
  blocks: TimeBlock[];
  onChange: (b: TimeBlock[]) => void;
}) {
  const toText = (b: TimeBlock[]) =>
    (b || []).map((x) => `${toHHMM(x.start)} - ${toHHMM(x.end)}`).join(", ");

  // Initialize from props, but don't overwrite while user types
  const [text, setText] = useState<string>(() => toText(blocks || []));

  // If parent changes blocks externally (e.g., load-from-cloud), refresh textarea
  useEffect(() => {
    setText(toText(blocks || []));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(blocks)]);

  const parse = (s: string): TimeBlock[] => {
    const items = s
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const out: TimeBlock[] = [];
    for (const it of items) {
      const m = it.match(
        /(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)/i
      );
      if (!m) continue;
      const h1 =
        (parseInt(m[1], 10) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
      const h2 =
        (parseInt(m[4], 10) % 12) + (m[6].toLowerCase() === "pm" ? 12 : 0);
      const s1 = h1 * 60 + parseInt(m[2], 10);
      const s2 = h2 * 60 + parseInt(m[5], 10);
      if (s2 > s1) out.push({ start: s1, end: s2 });
    }
    return out.sort((a, b) => a.start - b.start);
  };

  return (
    <textarea
      style={{ width: "100%", minHeight: 72 }}
      placeholder="e.g. 9:00 am - 12:00 pm, 1:00 pm - 3:00 pm"
      value={text}
      onChange={(e) => {
        // just update local text while typing
        setText(e.target.value);
      }}
      onBlur={() => {
        // when the user leaves the field, normalize & push up
        const arr = parse(text);
        onChange(arr);
        setText(toText(arr));
      }}
    />
  );
}

function ClosedDaysEditor({
  days,
  onChange,
}: {
  days: string[];
  onChange: (arr: string[]) => void;
}) {
  const [val, setVal] = useState("");
  return (
    <div>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
        Add ISO dates (yyyy-mm-dd) that are fully closed.
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="date"
          value={val}
          onChange={(e) => setVal(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            if (!val) return;
            if (!days.includes(val)) onChange([...days, val].sort());
            setVal("");
          }}
        >
          Add day
        </button>
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap" }}>
        {days.map((d) => (
          <span
            key={d}
            style={{
              border: "1px solid #e5e7eb",
              borderRadius: 8,
              padding: "2px 8px",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
            }}
          >
            {d}
            <button
              type="button"
              onClick={() => onChange(days.filter((x) => x !== d))}
              title="Remove"
            >
              ✕
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

function OneOffEditor({
  data,
  onChange,
}: {
  data: Record<string, TimeBlock[]>;
  onChange: (m: Record<string, TimeBlock[]>) => void;
}) {
  const [date, setDate] = useState("");
  const [text, setText] = useState("");

  const parse = (s: string): TimeBlock[] => {
    const items = s
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const out: TimeBlock[] = [];
    for (const it of items) {
      const m = it.match(
        /(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)/i
      );
      if (!m) continue;
      const h1 =
        (parseInt(m[1], 10) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
      const h2 =
        (parseInt(m[4], 10) % 12) + (m[6].toLowerCase() === "pm" ? 12 : 0);
      const s1 = h1 * 60 + parseInt(m[2], 10);
      const s2 = h2 * 60 + parseInt(m[5], 10);
      if (s2 > s1) out.push({ start: s1, end: s2 });
    }
    return out.sort((a, b) => a.start - b.start);
  };

  return (
    <div>
      <div style={{ fontSize: 12, color: "#6b7280", marginBottom: 8 }}>
        Add exclusions for a specific date. Example:{" "}
        <i>10:00 am - 12:00 pm, 2:15 pm - 3:00 pm</i>
      </div>
      <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
        <input
          style={{ flex: 1 }}
          placeholder="time ranges…"
          value={text}
          onChange={(e) => setText(e.target.value)}
        />
        <button
          type="button"
          onClick={() => {
            if (!date) return;
            const arr = parse(text);
            const next = { ...data };
            next[date] = arr;
            onChange(next);
            setText("");
          }}
        >
          Save for date
        </button>
      </div>
      <div style={{ display: "grid", gap: 6 }}>
        {Object.keys(data)
          .sort()
          .map((d) => (
            <div
              key={d}
              style={{
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <span>
                <b>{d}</b>{" "}
                <span style={{ color: "#6b7280" }}>
                  {(data[d] || [])
                    .map((b) => `${toHHMM(b.start)}–${toHHMM(b.end)}`)
                    .join(", ")}
                </span>
              </span>
              <button
                type="button"
                onClick={() => {
                  const next = { ...data };
                  delete next[d];
                  onChange(next);
                }}
              >
                Remove
              </button>
            </div>
          ))}
      </div>
    </div>
  );
}

/* -----------------------
   Calendar (weekly grid)
----------------------- */

function CalendarWeeks({
  weeks,
  getColor,
  onToggleLock,
  isLocked,
}: {
  weeks: { wk: string; blocks: ScheduledBlock[] }[];
  getColor: (clientId: string) => string;
  onToggleLock: (b: ScheduledBlock) => void;
  isLocked: (b: ScheduledBlock) => boolean;
}) {
  if (weeks.length === 0) return <div>No sessions to show.</div>;

  return (
    <div style={{ display: "grid", gap: 16 }}>
      {weeks.map(({ wk, blocks }) => (
        <CalendarWeek
          key={wk}
          wkStartISO={wk}
          blocks={blocks}
          getColor={getColor}
          onToggleLock={onToggleLock}
          isLocked={isLocked}
        />
      ))}
    </div>
  );
}

function CalendarWeek({
  wkStartISO,
  blocks,
  getColor,
  onToggleLock,
  isLocked,
}: {
  wkStartISO: string;
  blocks: ScheduledBlock[];
  getColor: (clientId: string) => string;
  onToggleLock: (b: ScheduledBlock) => void;
  isLocked: (b: ScheduledBlock) => boolean;
}) {
  const start = parseISO(wkStartISO);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const pxPerMin = 0.5; // 30px per hour
  const dayStartMin = 7 * 60;
  const dayEndMin = 19 * 60;
  const dayHeight = (dayEndMin - dayStartMin) * pxPerMin;

  const byDay: Record<string, ScheduledBlock[]> = {};
  for (const b of blocks) (byDay[b.date] ||= []).push(b);

  return (
    <div>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        Week of {wkStartISO}
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "60px repeat(7, minmax(0,1fr))",
          gap: 6,
          alignItems: "start",
        }}
      >
        <div />
        {days.map((d) => (
          <div
            key={`hdr-${DATE_FMT(d)}`}
            style={{ textAlign: "center", fontWeight: 700 }}
          >
            {d.toLocaleDateString(undefined, { weekday: "short" })}{" "}
            {DATE_FMT(d)}
          </div>
        ))}

        <div
          style={{
            position: "relative",
            height: dayHeight,
            borderRight: "1px solid #e5e7eb",
          }}
        >
          {Array.from(
            { length: (dayEndMin - dayStartMin) / 60 + 1 },
            (_, i) => dayStartMin + i * 60
          ).map((m) => (
            <div
              key={m}
              style={{
                position: "absolute",
                top: (m - dayStartMin) * pxPerMin - 8,
              }}
            >
              <span style={{ fontSize: 12, color: "#6b7280" }}>
                {toHHMM(m).replace(":00 ", " ")}
              </span>
            </div>
          ))}
        </div>

        {days.map((d) => {
          const iso = DATE_FMT(d);
          const dayBlocks = (byDay[iso] || []).sort(
            (a, b) => a.start - b.start
          );
          return (
            <div
              key={iso}
              style={{
                position: "relative",
                height: dayHeight,
                border: "1px solid #e5e7eb",
                borderRadius: 8,
                background: "#fff",
              }}
            >
              {Array.from(
                { length: (dayEndMin - dayStartMin) / 60 + 1 },
                (_, i) => dayStartMin + i * 60
              ).map((m) => (
                <div
                  key={`line-${m}`}
                  style={{
                    position: "absolute",
                    top: (m - dayStartMin) * pxPerMin,
                    left: 0,
                    right: 0,
                    height: 1,
                    background: "#f3f4f6",
                  }}
                />
              ))}
              {dayBlocks.map((b, idx) => {
                const top = Math.max(0, (b.start - dayStartMin) * pxPerMin);
                const height = Math.max(10, (b.end - b.start) * pxPerMin);
                const lockedNow = isLocked(b);
                return (
                  <div
                    key={`${iso}-${idx}`}
                    title={`${b.clientId} • ${toHHMM(b.start)}–${toHHMM(
                      b.end
                    )}`}
                    onClick={() => onToggleLock(b)}
                    style={{
                      position: "absolute",
                      left: 4,
                      right: 4,
                      top,
                      height,
                      background: getColor(b.clientId),
                      color: "#fff",
                      borderRadius: 6,
                      boxShadow: "0 2px 6px rgba(0,0,0,.15)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "0 6px",
                      fontSize: 12,
                      cursor: "pointer",
                      outline: lockedNow ? "2px solid #4c1d95" : "none",
                    }}
                  >
                    <span style={{ fontWeight: 700 }}>{b.clientId}</span>
                    <span>
                      {toHHMM(b.start)}–{toHHMM(b.end)}
                    </span>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/* -----------------------
   Add Client Form
----------------------- */

function ClientForm({ onAdd }: { onAdd: (c: Client) => void }) {
  const [id, setId] = useState("");
  const [color, setColor] = useState("#4f46e5");
  const [supPercent, setSupPercent] = useState(10);
  const [minSessionMins, setMinSessionMins] = useState(60);
  const [maxSessionsPerWeek, setMaxSessionsPerWeek] = useState<number | null>(
    null
  );
  const [maxSessionsPerDay, setMaxSessionsPerDay] = useState<number | null>(1); // sensible default
  const [preferNoSubHour, setPreferNoSubHour] = useState(true);

  const [slot1, setSlot1] = useState<Record<DayKey, boolean>>({
    sun: false,
    mon: false,
    tue: false,
    wed: false,
    thu: false,
    fri: false,
    sat: false,
  });
  const [slot2, setSlot2] = useState<Record<DayKey, boolean>>({
    sun: false,
    mon: false,
    tue: false,
    wed: false,
    thu: false,
    fri: false,
    sat: false,
  });

  const [win, setWin] = useState<Record<DayKey, string>>({
    sun: "",
    mon: "",
    tue: "",
    wed: "",
    thu: "",
    fri: "",
    sat: "",
  });

  const parseRanges = (s: string): TimeBlock[] => {
    const items = s
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    const out: TimeBlock[] = [];
    for (const it of items) {
      const m = it.match(
        /(\d{1,2}):(\d{2})\s*(am|pm)\s*-\s*(\d{1,2}):(\d{2})\s*(am|pm)/i
      );
      if (!m) continue;
      const h1 =
        (parseInt(m[1], 10) % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
      const h2 =
        (parseInt(m[4], 10) % 12) + (m[6].toLowerCase() === "pm" ? 12 : 0);
      const s1 = h1 * 60 + parseInt(m[2], 10);
      const s2 = h2 * 60 + parseInt(m[5], 10);
      if (s2 > s1) out.push({ start: s1, end: s2 });
    }
    return out.sort((a, b) => a.start - b.start);
  };

  const toWindows = (): DayWindow[] =>
    DAYS.map((d) => ({ day: d, blocks: parseRanges(win[d]) }));

  const toPreferred = (): DayKey[][] => {
    const picks = (r: Record<DayKey, boolean>) =>
      DAYS.filter((k) => !!r[k]) as DayKey[];
    const res: DayKey[][] = [];
    const r1 = picks(slot1);
    const r2 = picks(slot2);
    if (r1.length) res.push(r1);
    if (r2.length) res.push(r2);
    return res;
  };

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!id.trim()) {
      alert("Client id required");
      return;
    }
    const c: Client = {
      id: id.trim(),
      color,
      supPercent: Number(supPercent) || 10,
      minSessionMins: Number(minSessionMins) || 60,
      maxSessionsPerWeek,
      maxSessionsPerDay,
      preferNoSubHour,
      preferredDaySlots: toPreferred(),
      windows: toWindows(),
    };
    onAdd(c);

    setId("");
    setWin({ sun: "", mon: "", tue: "", wed: "", thu: "", fri: "", sat: "" });
    setSlot1({
      sun: false,
      mon: false,
      tue: false,
      wed: false,
      thu: false,
      fri: false,
      sat: false,
    });
    setSlot2({
      sun: false,
      mon: false,
      tue: false,
      wed: false,
      thu: false,
      fri: false,
      sat: false,
    });
    setMaxSessionsPerDay(1);
    setMaxSessionsPerWeek(null);
  };

  const DayChecks = ({
    value,
    onChange,
  }: {
    value: Record<DayKey, boolean>;
    onChange: (v: Record<DayKey, boolean>) => void;
  }) => (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
      {DAYS.map((d) => (
        <label
          key={d}
          style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
        >
          <input
            type="checkbox"
            checked={!!value[d]}
            onChange={(e) => onChange({ ...value, [d]: e.target.checked })}
          />
          {d[0].toUpperCase() + d.slice(1)}
        </label>
      ))}
    </div>
  );

  return (
    <form
      onSubmit={onSubmit}
      style={{ border: "1px solid #e5e7eb", borderRadius: 12, padding: 12 }}
    >
      <h2>Add Client</h2>
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(3, minmax(0,1fr))",
        }}
      >
        <div>
          <label>Client ID</label>
          <input value={id} onChange={(e) => setId(e.target.value)} />
        </div>
        <div>
          <label>Color</label>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
          />
        </div>
        <div>
          <label>Supervision %</label>
          <input
            type="number"
            value={supPercent}
            onChange={(e) => setSupPercent(Number(e.target.value))}
          />
        </div>
        <div>
          <label>Min session (mins)</label>
          <input
            type="number"
            value={minSessionMins}
            onChange={(e) => setMinSessionMins(Number(e.target.value))}
          />
        </div>
        <div>
          <label>Max sessions/week (optional)</label>
          <input
            type="number"
            value={maxSessionsPerWeek ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              setMaxSessionsPerWeek(v === "" ? null : Number(v));
            }}
          />
        </div>
        <div>
          <label>Max sessions/day (optional)</label>
          <input
            type="number"
            value={maxSessionsPerDay ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              setMaxSessionsPerDay(v === "" ? null : Number(v));
            }}
          />
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <input
            type="checkbox"
            checked={preferNoSubHour}
            onChange={(e) => setPreferNoSubHour(e.target.checked)}
          />
          <label>Prefer no sub-hour</label>
        </div>
      </div>

      <h3 style={{ marginTop: 12 }}>Preferred weekly day patterns (slots)</h3>
      <div style={{ display: "grid", gap: 10 }}>
        <div>
          <b>Slot 1</b>
          <DayChecks value={slot1} onChange={setSlot1} />
        </div>
        <div>
          <b>Slot 2</b>
          <DayChecks value={slot2} onChange={setSlot2} />
        </div>
      </div>

      <h3 style={{ marginTop: 12 }}>Authorized windows (per day)</h3>
      <div
        style={{
          display: "grid",
          gap: 8,
          gridTemplateColumns: "repeat(2, minmax(0,1fr))",
        }}
      >
        {DAYS.map((d) => (
          <div key={d}>
            <label style={{ display: "block" }}>{d.toUpperCase()}</label>
            <input
              placeholder="e.g. 2:30 pm - 5:30 pm, 9:00 am - 10:15 am"
              value={win[d]}
              onChange={(e) => setWin({ ...win, [d]: e.target.value })}
            />
          </div>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        <button type="submit">Add</button>
      </div>
    </form>
  );
}

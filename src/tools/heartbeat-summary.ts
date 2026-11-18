import { z } from 'zod';
import type { Heartbeat } from '../types/index.js';

/**
 * What listHeartbeats returns for more than one beat, unless raw rows are asked for: the
 * questions asked of a run of beats ("was it down?", "why?", "how slow?") answered on the server.
 * A hundred rows cost the model 15–20K characters of context for the rest of the session; their
 * summary costs a few hundred.
 */

const STATUS_NAMES: Record<number, string> = { 0: 'down', 1: 'up', 2: 'pending', 3: 'maintenance' };

const statusName = (status: number) => STATUS_NAMES[status] ?? String(status);

export const HeartbeatSummarySchema = z.object({
  // No `to`: it would be latest.time again.
  from: z.string().describe('Time of the oldest beat summarised, UTC with no zone marker; latest.time is the newest'),
  beats: z.number().describe('How many beats are summarised'),
  counts: z
    .record(z.string(), z.number())
    .describe('Beats per status (up, down, pending, maintenance); a status with none is left out'),
  ping: z
    .object({ min: z.number(), avg: z.number(), max: z.number() })
    .optional()
    .describe('Response time in ms over the beats that have one'),
  latest: z
    .object({
      time: z.string(),
      status: z.string().describe('up, down, pending or maintenance'),
      msg: z.string().optional(),
      since: z
        .string()
        .optional()
        .describe('When the monitor entered this status, if that is within the beats summarised'),
    })
    .describe('The newest beat'),
  downPeriods: z
    .array(
      z.object({
        start: z.string().describe('Time of the first DOWN beat'),
        end: z.string().optional().describe('Time of the first beat after it that was not DOWN; absent if still down'),
        beats: z.number().describe('How many DOWN beats in a row'),
        msg: z.string().optional().describe('Message of the first DOWN beat'),
      })
    )
    .optional()
    .describe('Each run of DOWN beats, newest first'),
});

export type HeartbeatSummary = z.infer<typeof HeartbeatSummarySchema>;

/** Summarises beats given newest first, as the cache keeps them. Undefined for no beats. */
export function summariseHeartbeats(beats: readonly Heartbeat[]): HeartbeatSummary | undefined {
  if (beats.length === 0) return undefined;
  const newest = beats[0];
  const oldest = beats[beats.length - 1];

  const counts: Record<string, number> = {};
  for (const b of beats) counts[statusName(b.status)] = (counts[statusName(b.status)] ?? 0) + 1;

  const pings = beats.map((b) => b.ping).filter((p): p is number => typeof p === 'number');
  const ping =
    pings.length > 0
      ? {
          min: Math.min(...pings),
          avg: Math.round(pings.reduce((sum, p) => sum + p, 0) / pings.length),
          max: Math.max(...pings),
        }
      : undefined;

  // The newest beat's status began at the oldest beat of the unbroken run that ends with it.
  // If that run reaches the oldest beat summarised, the change is out of view, so `since` is left out.
  let run = 0;
  while (run + 1 < beats.length && beats[run + 1].status === newest.status) run++;
  const since = run + 1 < beats.length ? beats[run].time : undefined;

  // Walk oldest to newest so each period starts at its first DOWN beat and ends at the first
  // beat after it that is not DOWN; then list them newest first, like the beats.
  const downPeriods: NonNullable<HeartbeatSummary['downPeriods']> = [];
  let current: (typeof downPeriods)[number] | undefined;
  for (let i = beats.length - 1; i >= 0; i--) {
    const b = beats[i];
    if (b.status === 0) {
      if (current) current.beats++;
      else current = { start: b.time, beats: 1, msg: b.msg || undefined };
    } else if (current) {
      downPeriods.push({ start: current.start, end: b.time, beats: current.beats, msg: current.msg });
      current = undefined;
    }
  }
  if (current) downPeriods.push(current);
  downPeriods.reverse();

  return {
    from: oldest.time,
    beats: beats.length,
    counts,
    ...(ping && { ping }),
    latest: {
      time: newest.time,
      status: statusName(newest.status),
      ...(newest.msg && { msg: newest.msg }),
      ...(since && { since }),
    },
    ...(downPeriods.length > 0 && { downPeriods }),
  };
}

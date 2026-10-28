import type { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../database";
import { sweepMissAlerts } from "./miss-sweep";

/**
 * Hit by a free external scheduler (cron-job.org / UptimeRobot) every ~5 minutes:
 *   GET /api/cron/tick?key=<CRON_SECRET>
 * It keeps the Render free instance awake, keeps the Turso database active, and runs the
 * missed-day alert sweep on a real schedule instead of relying on Today traffic.
 * The sweep itself is idempotent (unique owner/date claims), so overlapping ticks are safe.
 */
const SWEEP_EVERY_MS = 10 * 60 * 1000;
let lastSweep = 0;
let running = false;

export function registerCron(app: Hono) {
  app.get("/api/cron/tick", async (c) => {
    const secret = process.env.CRON_SECRET?.trim();
    if (!secret || c.req.query("key") !== secret) return c.json({ ok: false }, 401);
    await db.run(sql`select 1`);
    let swept = false;
    if (!running && Date.now() - lastSweep >= SWEEP_EVERY_MS) {
      lastSweep = Date.now();
      running = true;
      swept = true;
      sweepMissAlerts().catch(() => console.error("[cron] sweep_failed")).finally(() => { running = false; });
    }
    return c.json({ ok: true, swept }, 200);
  });
}

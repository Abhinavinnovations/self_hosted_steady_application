import type { Hono } from "hono";
import { sql } from "drizzle-orm";
import { db } from "../database";
import { BOOTSTRAP_STATEMENTS } from "../database/bootstrap-sql";

/**
 * Self-hosting safety net: on boot, make sure every table, column and index the app needs
 * exists in the configured database. Additive only — it never drops or rewrites anything,
 * so it is safe on an existing database and creates everything on an empty one.
 */
export type BootstrapReport = {
  ok: boolean;
  error?: string;
  createdTables: string[];
  addedColumns: string[];
  failed: string[];
  at: string;
};

let report: BootstrapReport | null = null;
let running: Promise<BootstrapReport> | null = null;

const sanitize = (e: unknown) =>
  String((e as { message?: string })?.message ?? e)
    .replace(/(libsql|https?|wss?):\/\/\S+/gi, "<url>")
    .replace(/ey[A-Za-z0-9_-]{20,}\S*/g, "<token>")
    .slice(0, 300);

const ifNotExists = (stmt: string) =>
  stmt
    .replace(/^CREATE TABLE `/, "CREATE TABLE IF NOT EXISTS `")
    .replace(/^CREATE UNIQUE INDEX `/, "CREATE UNIQUE INDEX IF NOT EXISTS `")
    .replace(/^CREATE INDEX `/, "CREATE INDEX IF NOT EXISTS `");

async function existingColumns(table: string) {
  const res = await db.run(sql.raw(`PRAGMA table_info(\`${table}\`)`));
  return new Set(res.rows.map((r) => String((r as Record<string, unknown>).name ?? (r as unknown[])[1])));
}

async function run(): Promise<BootstrapReport> {
  const r: BootstrapReport = { ok: true, createdTables: [], addedColumns: [], failed: [], at: new Date().toISOString() };
  try {
    const before = await db.run(sql`select name from sqlite_master where type = 'table'`);
    const tables = new Set(before.rows.map((x) => String((x as Record<string, unknown>).name ?? (x as unknown[])[0])));

    for (const stmt of BOOTSTRAP_STATEMENTS) {
      const table = stmt.match(/^CREATE TABLE `([^`]+)`/)?.[1];
      if (table && tables.has(table)) {
        // Table exists: add any columns the current code expects but the DB lacks.
        const have = await existingColumns(table);
        for (const line of stmt.split("\n")) {
          const m = line.match(/^\t`([^`]+)` (.+?),?$/);
          if (!m || have.has(m[1]!) || /PRIMARY KEY/.test(m[2]!)) continue;
          const def = m[2]!;
          try {
            await db.run(sql.raw(`ALTER TABLE \`${table}\` ADD COLUMN \`${m[1]}\` ${def}`));
            r.addedColumns.push(`${table}.${m[1]}`);
          } catch {
            // SQLite refuses NOT NULL without a constant default; add it nullable instead.
            const loose = def.replace(/\s+NOT NULL/gi, "").replace(/\s+DEFAULT\s+\(.*\)/i, "");
            try {
              await db.run(sql.raw(`ALTER TABLE \`${table}\` ADD COLUMN \`${m[1]}\` ${loose}`));
              r.addedColumns.push(`${table}.${m[1]}(nullable)`);
            } catch (e) {
              r.failed.push(`${table}.${m[1]}: ${sanitize(e)}`);
            }
          }
        }
        continue;
      }
      try {
        await db.run(sql.raw(ifNotExists(stmt)));
        if (table) r.createdTables.push(table);
      } catch (e) {
        r.failed.push(`${table ?? stmt.slice(0, 60)}: ${sanitize(e)}`);
      }
    }
  } catch (e) {
    r.ok = false;
    r.error = sanitize(e);
  }
  if (r.failed.length) r.ok = false;
  console.log("[schema-bootstrap]", JSON.stringify(r));
  return r;
}

export function ensureSchema(): Promise<BootstrapReport> {
  if (report?.ok) return Promise.resolve(report);
  if (!running) {
    running = run().then((res) => {
      report = res;
      running = null;
      return res;
    });
  }
  return running;
}

export function registerSchemaBootstrap(app: Hono) {
  void ensureSchema();
  // Requests wait for the first bootstrap (milliseconds after boot); retried while it fails.
  app.use("/api/*", async (c, next) => {
    if (!report?.ok && !c.req.path.startsWith("/api/health")) await ensureSchema();
    await next();
  });

  // Public, secret-free diagnostics to debug a self-hosted deploy.
  app.get("/api/health/deep", async (c) => {
    let database = "ok";
    try {
      await db.run(sql`select 1`);
    } catch (e) {
      database = sanitize(e);
    }
    const r = await ensureSchema();
    const has = (k: string) => !!process.env[k]?.trim();
    return c.json({
      database,
      schema: r,
      config: {
        WEBSITE_URL: process.env.WEBSITE_URL ?? null,
        BETTER_AUTH_SECRET: has("BETTER_AUTH_SECRET"),
        DATABASE_URL: has("DATABASE_URL"),
        DATABASE_AUTH_TOKEN: has("DATABASE_AUTH_TOKEN"),
        GOOGLE_CLIENT_ID: has("GOOGLE_CLIENT_ID"),
        GOOGLE_CLIENT_SECRET: has("GOOGLE_CLIENT_SECRET"),
        GEMINI_API_KEY: has("GEMINI_API_KEY"),
        GMAIL_USER: has("GMAIL_USER"),
        GMAIL_RELAY_URL: has("GMAIL_RELAY_URL"),
        GMAIL_RELAY_SECRET: has("GMAIL_RELAY_SECRET"),
        CRON_SECRET: has("CRON_SECRET"),
      },
    });
  });
}

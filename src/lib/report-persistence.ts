import { mkdirSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";

import { getReportPersistenceMode } from "@/lib/env";
import type { Report, ReportRequest } from "@/lib/types";

const require = createRequire(import.meta.url);
const storagePath = join(process.cwd(), "data", "report-jobs.sqlite");

interface Statement {
  all(): unknown[];
  get(...params: unknown[]): unknown;
  run(...params: unknown[]): void;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}

export interface PersistedJob {
  id: string;
  createdAt: number;
  request: ReportRequest;
  report?: Report;
  error?: string;
}

function persistenceMode() {
  return getReportPersistenceMode();
}

function ensureStorageDir() {
  mkdirSync(dirname(storagePath), { recursive: true });
}

let database: SqliteDatabase | null = null;

function getDatabase() {
  if (persistenceMode() !== "sqlite") {
    return null;
  }

  if (database) {
    return database;
  }

  ensureStorageDir();
  const sqliteModule = require("node:sqlite") as {
    DatabaseSync: new (path: string) => SqliteDatabase;
  };
  database = new sqliteModule.DatabaseSync(storagePath);
  database.exec(`
    CREATE TABLE IF NOT EXISTS report_jobs (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      request_json TEXT NOT NULL,
      report_json TEXT,
      error TEXT
    )
  `);

  return database;
}

export function loadPersistedJobs(): PersistedJob[] {
  const db = getDatabase();
  if (!db) {
    return [];
  }

  try {
    const rows = db.prepare(
      `SELECT id, created_at, request_json, report_json, error
       FROM report_jobs
       ORDER BY created_at ASC`,
    ).all() as Array<{
      id: string;
      created_at: number;
      request_json: string;
      report_json: string | null;
      error: string | null;
    }>;

    return rows.map((row) => ({
      id: row.id,
      createdAt: row.created_at,
      request: JSON.parse(row.request_json) as ReportRequest,
      report: row.report_json ? (JSON.parse(row.report_json) as Report) : undefined,
      error: row.error || undefined,
    }));
  } catch {
    return [];
  }
}

export function listPersistedJobs(): PersistedJob[] {
  return loadPersistedJobs();
}

export function getPersistedJobById(id: string): PersistedJob | null {
  const db = getDatabase();
  if (!db) {
    return null;
  }

  try {
    const row = db.prepare(
      `SELECT id, created_at, request_json, report_json, error
       FROM report_jobs
       WHERE id = ?`,
    ).get(id) as
      | {
          id: string;
          created_at: number;
          request_json: string;
          report_json: string | null;
          error: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: row.id,
      createdAt: row.created_at,
      request: JSON.parse(row.request_json) as ReportRequest,
      report: row.report_json ? (JSON.parse(row.report_json) as Report) : undefined,
      error: row.error || undefined,
    };
  } catch {
    return null;
  }
}

function normaliseSubject(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

export function getPreviousCompletedReportBySubject(input: {
  subjectName: string;
  subjectType: ReportRequest["subject_type"];
  excludeReportId?: string;
}): Report | null {
  const jobs = loadPersistedJobs()
    .filter((job) => job.report)
    .sort((left, right) => right.createdAt - left.createdAt);

  const match = jobs.find((job) => {
    if (!job.report) {
      return false;
    }

    if (input.excludeReportId && job.report.id === input.excludeReportId) {
      return false;
    }

    return (
      job.report.subject_type === input.subjectType &&
      normaliseSubject(job.report.subject_name) === normaliseSubject(input.subjectName)
    );
  });

  return match?.report || null;
}

export function savePersistedJobs(jobs: PersistedJob[]) {
  const db = getDatabase();
  if (!db) {
    return;
  }

  const upsert = db.prepare(`
    INSERT INTO report_jobs (id, created_at, request_json, report_json, error)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      created_at = excluded.created_at,
      request_json = excluded.request_json,
      report_json = excluded.report_json,
      error = excluded.error
  `);

  db.exec("BEGIN");

  try {
    if (!jobs.length) {
      db.exec("DELETE FROM report_jobs");
      db.exec("COMMIT");
      return;
    }

    const ids = jobs.map((item) => item.id);
    const placeholders = ids.map(() => "?").join(", ");
    db.prepare(`DELETE FROM report_jobs WHERE id NOT IN (${placeholders})`).run(...ids);

    for (const item of jobs) {
      upsert.run(
        item.id,
        item.createdAt,
        JSON.stringify(item.request),
        item.report ? JSON.stringify(item.report) : null,
        item.error || null,
      );
    }

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

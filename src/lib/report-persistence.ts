import { mkdirSync } from "fs";
import { dirname, join } from "path";
import { DatabaseSync } from "node:sqlite";

import type { Report, ReportRequest } from "@/lib/types";

const storagePath = join(process.cwd(), "data", "report-jobs.sqlite");

export interface PersistedJob {
  id: string;
  createdAt: number;
  request: ReportRequest;
  report?: Report;
  error?: string;
}

function ensureStorageDir() {
  mkdirSync(dirname(storagePath), { recursive: true });
}

let database: DatabaseSync | null = null;

function getDatabase() {
  if (database) {
    return database;
  }

  ensureStorageDir();
  database = new DatabaseSync(storagePath);
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
  try {
    const db = getDatabase();
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
  try {
    const db = getDatabase();
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

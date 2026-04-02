import Link from "next/link";

import { listPersistedJobs } from "@/lib/report-persistence";

function formatDate(value: number) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export default function ReportsPage() {
  const jobs = listPersistedJobs().sort((left, right) => right.createdAt - left.createdAt);

  return (
    <main className="page-shell">
      <section className="panel report-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Reports</p>
            <h2>Report history</h2>
          </div>
          <div className="report-actions">
            <Link className="secondary-link" href="/">
              New report
            </Link>
          </div>
        </div>

        {jobs.length ? (
          <div className="history-list">
            {jobs.map((job) => (
              <article className="history-card" key={job.id}>
                <div>
                  <strong>{job.report?.subject_name || job.request.subject_name}</strong>
                  <p>{job.request.subject_type === "organisation" ? "Organisation" : "Individual"}</p>
                  <small>{formatDate(job.createdAt)}</small>
                </div>
                <div className="history-meta">
                  <span
                    className={`coverage-pill ${
                      job.report ? "coverage-returned" : job.error ? "coverage-fallback" : "coverage-empty"
                    }`}
                  >
                    {job.report ? "Complete" : job.error ? "Failed" : "Processing"}
                  </span>
                  <Link className="secondary-link" href={`/reports/${job.id}`}>
                    View report
                  </Link>
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="report-placeholder">
            <div className="placeholder-card">
              <h3>No saved reports yet</h3>
              <p>Generate a report from the home page and it will appear here.</p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

import Link from "next/link";
import { notFound } from "next/navigation";

import { ReportView } from "@/components/report-shell";
import { getPersistedJobById } from "@/lib/report-persistence";

export default async function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = getPersistedJobById(id);

  if (!job) {
    notFound();
  }

  return (
    <main className="page-shell">
      <section className="panel report-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Report</p>
            <h2>{job.report ? "Saved due diligence report" : "Report status"}</h2>
          </div>
          <div className="report-actions">
            <Link className="secondary-link" href="/reports">
              History
            </Link>
            <Link className="secondary-link" href="/">
              New report
            </Link>
          </div>
        </div>

        {job.report ? (
          <ReportView report={job.report} />
        ) : (
          <div className="report-placeholder">
            <div className="placeholder-card">
              <h3>Report is not finished yet</h3>
              <p>
                This job exists in storage, but there is not a completed report payload available
                yet.
              </p>
            </div>
          </div>
        )}
      </section>
    </main>
  );
}

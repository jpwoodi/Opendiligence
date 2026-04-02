"use client";

import { useEffect } from "react";

export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main className="page-shell">
      <section className="panel report-panel">
        <div className="panel-header">
          <p className="eyebrow">OpenDiligence</p>
          <h2>Something went wrong</h2>
        </div>
        <div className="report-placeholder">
          <div className="placeholder-card">
            <h3>The app hit an unexpected error</h3>
            <p>Please retry the last action. If it keeps happening, start a fresh run.</p>
            <button className="primary-button" onClick={reset} type="button">
              Try again
            </button>
          </div>
        </div>
      </section>
    </main>
  );
}

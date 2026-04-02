"use client";

import Link from "next/link";
import { FormEvent, useEffect, useMemo, useState } from "react";

import type {
  AgentResponse,
  Citation,
  DebugEvent,
  ProviderRunStatus,
  Report,
  ReportJob,
  ReportProgress,
  ReportRequest,
  ReportStatusResponse,
  RiskLevel,
  SubjectType,
} from "@/lib/types";

const initialForm: ReportRequest = {
  subject_name: "",
  subject_type: "organisation",
  jurisdiction: "gb",
  company_number: "",
  date_of_birth: "",
  additional_context: "",
};

const stepLabels: Array<{ key: keyof ReportProgress; label: string }> = [
  { key: "corporate_records", label: "Searching corporate records" },
  { key: "web_search", label: "Scanning web sources" },
  { key: "sanctions_screening", label: "Screening sanctions and PEP lists" },
  { key: "analysis", label: "Analysing findings and generating report" },
];

const providerLabels: Record<string, string> = {
  companies_house: "Companies House",
  gleif: "GLEIF",
  icij: "ICIJ Offshore Leaks",
  insolvency_register: "UK Insolvency Gazette",
  fca_warning_list: "FCA Warning List",
  brave_search: "Brave Search",
  opensanctions: "OpenSanctions",
  world_bank_debarments: "World Bank Debarments",
  analysis: "Report synthesis",
};

const jurisdictionOptions = [
  { value: "", label: "Any jurisdiction" },
  { value: "gb", label: "United Kingdom" },
  { value: "us", label: "United States" },
  { value: "ie", label: "Ireland" },
  { value: "ae", label: "United Arab Emirates" },
  { value: "sg", label: "Singapore" },
  { value: "hk", label: "Hong Kong" },
  { value: "ch", label: "Switzerland" },
  { value: "je", label: "Jersey" },
  { value: "gg", label: "Guernsey" },
];

function riskLabel(level: RiskLevel) {
  return level.charAt(0).toUpperCase() + level.slice(1);
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
  }).format(new Date(value));
}

function riskClass(level: RiskLevel) {
  return `risk-pill risk-${level}`;
}

function labelCase(value: string) {
  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function buildApiHeaders(accessKey: string) {
  const trimmed = accessKey.trim();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (trimmed) {
    headers["x-opendiligence-key"] = trimmed;
  }

  return headers;
}

function buildPendingStatus(reportId: string): ReportStatusResponse {
  return {
    report_id: reportId,
    status: "processing",
    progress: {
      corporate_records: "in_progress",
      web_search: "pending",
      sanctions_screening: "pending",
      analysis: "pending",
    },
    provider_status: {
      companies_house: "pending",
      gleif: "pending",
      icij: "pending",
      insolvency_register: "pending",
      fca_warning_list: "pending",
      brave_search: "pending",
      opensanctions: "pending",
      world_bank_debarments: "pending",
      analysis: "pending",
    },
  };
}

function isAffirmativeMessage(value: string) {
  return /^(yes|yep|yeah|confirm|continue|proceed|go ahead|yes please)$/i.test(value.trim());
}

function isNegativeMessage(value: string) {
  return /^(no|nope|cancel|stop|different person)$/i.test(value.trim());
}

function splitSentences(text: string) {
  return text.match(/[^.!?]+[.!?]?/g)?.map((part) => part.trim()).filter(Boolean) || [text];
}

function CitedText({
  text,
  citations,
}: {
  text: string;
  citations: Citation[];
}) {
  const sentences = splitSentences(text);

  return (
    <p className="cited-text">
      {sentences.map((sentence, index) => {
        const citation = citations[Math.min(index, citations.length - 1)];

        return (
          <span className="cited-sentence" key={`${sentence}-${index}`}>
            {sentence}{" "}
            {citation ? (
              <a
                className="inline-citation"
                href={citation.url}
                target="_blank"
                rel="noreferrer"
                title={citation.title}
              >
                [{index + 1}]
              </a>
            ) : null}{" "}
          </span>
        );
      })}
    </p>
  );
}

function buildSourceCoverage(report: Report) {
  const urls = report.sources.map((source) => source.url);
  const warnings = report.warnings || [];
  const includesUrl = (pattern: string) => urls.some((url) => url.includes(pattern));

  return [
    {
      label: "Companies House",
      status: warnings.some((warning) => warning.includes("Companies House") || warning.includes("Corporate registry"))
        ? "fallback"
        : includesUrl("company-information.service.gov.uk")
          ? "returned"
          : "no_findings",
      detail:
        report.subject_type === "organisation"
          ? "Company profile, officers, and control records"
          : "Officer appointments and role history",
    },
    {
      label: "OpenSanctions",
      status: warnings.some((warning) => warning.includes("Sanctions screening fell back"))
        ? "fallback"
        : includesUrl("opensanctions.org")
          ? "returned"
          : "no_findings",
      detail: "Sanctions, PEP, and office-holder screening",
    },
    {
      label: "World Bank Debarments",
      status: warnings.some((warning) => warning.includes("World Bank Debarments screening could not be completed"))
        ? "fallback"
        : report.sanctions_screening.matches.some((match) => match.dataset === "World Bank Debarments")
          ? "returned"
          : "no_findings",
      detail: "World Bank ineligible firms and individuals",
    },
    {
      label: "Brave Search",
      status: warnings.some((warning) => warning.includes("Media research fell back"))
        ? "fallback"
        : report.adverse_media.length || report.positive_media.length
          ? "returned"
          : "no_findings",
      detail: "Adverse and positive public-source media",
    },
    {
      label: "ICIJ Offshore Leaks",
      status: includesUrl("offshoreleaks.icij.org") ? "returned" : "no_findings",
      detail: "Panama Papers / offshore and leaks-linked records",
    },
    {
      label: "UK Insolvency Gazette",
      status: warnings.some((warning) => warning.includes("Insolvency screening could not be completed"))
        ? "fallback"
        : includesUrl("thegazette.co.uk/notice/")
          ? "returned"
          : "no_findings",
      detail: "Corporate and personal insolvency notices",
    },
    {
      label: "GLEIF",
      status: includesUrl("gleif.org") ? "returned" : "no_findings",
      detail: "LEI identity and parent relationships",
    },
    {
      label: "FCA Warning List",
      status: includesUrl("fca.org.uk") ? "returned" : "no_findings",
      detail: "Unauthorised firm and scam warnings",
    },
  ] as const;
}

function sourceCoverageLabel(status: "returned" | "no_findings" | "fallback") {
  if (status === "returned") {
    return "Returned data";
  }

  if (status === "fallback") {
    return "Fallback/demo";
  }

  return "No findings";
}

function sourceCoverageClass(status: "returned" | "no_findings" | "fallback") {
  return status === "returned"
    ? "coverage-returned"
    : status === "fallback"
      ? "coverage-fallback"
      : "coverage-empty";
}

function providerStatusLabel(status: ProviderRunStatus) {
  return status === "done"
    ? "Done"
    : status === "running"
      ? "Running"
      : status === "error"
        ? "Error"
        : "Pending";
}

function providerStatusTone(status: ProviderRunStatus) {
  return status === "done"
    ? "returned"
    : status === "error"
      ? "fallback"
      : "empty";
}

function debugTone(level: DebugEvent["level"]) {
  return level === "error"
    ? "fallback"
    : level === "warning"
      ? "empty"
      : "returned";
}

function getMediaTriageNote(events?: DebugEvent[]) {
  return events?.find(
    (event) =>
      event.scope === "brave_search" &&
      event.message.toLowerCase().includes("media triage used"),
  );
}

function getIssueEvents(events?: DebugEvent[]) {
  return events?.filter((event) => event.level !== "info") || [];
}

function MediaList({ items }: { items: Report["adverse_media"] }) {
  return (
    <div className="stack-list">
      {items.map((item) => (
        <article className="stack-card media-card" key={`${item.source_url}-${item.summary}`}>
          <div className="media-header">
            <strong>{item.source_title}</strong>
            <span className={`severity-pill severity-${item.severity}`}>{item.severity}</span>
          </div>
          <CitedText
            text={item.summary}
            citations={[{ url: item.source_url, title: item.source_title }]}
          />
          {item.match_reason ? (
            <small>
              Match basis: {item.match_reason}
              {item.match_confidence ? ` | ${item.match_confidence}` : ""}
            </small>
          ) : null}
          {item.evidence_spans?.length ? (
            <div className="evidence-list">
              {item.evidence_spans.map((span) => (
                <blockquote key={span}>{span}</blockquote>
              ))}
            </div>
          ) : null}
          <small>
            {item.risk_category} | {item.date}
            {item.verification_status ? ` | ${item.verification_status}` : ""}
          </small>
          <a href={item.source_url} target="_blank" rel="noreferrer">
            View source
          </a>
        </article>
      ))}
    </div>
  );
}

function buildMediaTimeline(report: Report) {
  const timelineItems = [
    ...report.adverse_media.map((item) => ({ ...item, timeline_type: "adverse" as const })),
    ...report.positive_media.map((item) => ({ ...item, timeline_type: "positive" as const })),
  ]
    .slice()
    .sort((left, right) => right.date.localeCompare(left.date));

  const grouped = new Map<string, typeof timelineItems>();

  for (const item of timelineItems) {
    const date = new Date(item.date);
    const group = new Intl.DateTimeFormat("en-GB", {
      month: "long",
      year: "numeric",
    }).format(date);

    grouped.set(group, [...(grouped.get(group) || []), item]);
  }

  return [...grouped.entries()].map(([label, items]) => ({
    label,
    items,
  }));
}

function buildBackgroundSources(report: Report) {
  return report.sources.filter((source) => source.type === "background");
}

function buildAlternativeSources(report: Report) {
  return report.sources.filter((source) => source.type === "alternative");
}

export function ReportPlaceholder() {
  return (
    <div className="report-placeholder">
      <div className="placeholder-card">
        <h3>Structured report sections</h3>
        <p>
          Executive summary, ownership and control, sanctions screening, adverse media,
          associations, and a traffic-light risk matrix appear here once the run completes.
        </p>
      </div>
      <div className="placeholder-grid">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}

export function ReportLoadingState() {
  return (
    <div className="report-placeholder">
      <div className="placeholder-card">
        <h3>Report is being assembled</h3>
        <p>
          Live corporate, media, sanctions, and synthesis steps are still running. The full report
          will appear here as soon as processing completes.
        </p>
      </div>
      <div className="placeholder-grid">
        <div />
        <div />
        <div />
      </div>
    </div>
  );
}

export function ReportErrorState({ error }: { error?: string }) {
  return (
    <div className="report-placeholder">
      <div className="placeholder-card error-card">
        <h3>Report generation failed</h3>
        <p>{error || "The report job failed before a result could be returned."}</p>
      </div>
    </div>
  );
}

export function ReportView({ report }: { report: Report }) {
  const sourceCoverage = buildSourceCoverage(report);
  const mediaTimeline = buildMediaTimeline(report);
  const backgroundSources = buildBackgroundSources(report);
  const alternativeSources = buildAlternativeSources(report);

  return (
    <div className="report-view">
      <div className="report-summary">
        <div>
          <p className="eyebrow">Executive Summary</p>
          <h3>{report.subject_name}</h3>
          <CitedText
            text={report.executive_summary.text}
            citations={report.executive_summary.citations || []}
          />
        </div>
        <div className="summary-meta">
          <span className={riskClass(report.executive_summary.overall_risk)}>
            {riskLabel(report.executive_summary.overall_risk)}
          </span>
          <small>Generated {formatDate(report.created_at)}</small>
          <small>{report.sources.length} sources consulted</small>
        </div>
      </div>

      {report.warnings?.length ? (
        <div className="warning-banner">
          <strong>Prototype caveats</strong>
          {report.warnings.map((warning) => (
            <span key={warning}>{warning}</span>
          ))}
        </div>
      ) : null}

      <div className="report-grid">
        <section className="report-section">
          <h4>{report.subject_type === "organisation" ? "Corporate Profile" : "Subject Profile"}</h4>
          {report.corporate_profile ? (
            <dl className="key-value-grid">
              <div>
                <dt>Company number</dt>
                <dd>{report.corporate_profile.company_number}</dd>
              </div>
              <div>
                <dt>Status</dt>
                <dd>{report.corporate_profile.status}</dd>
              </div>
              <div>
                <dt>Type</dt>
                <dd>{report.corporate_profile.type}</dd>
              </div>
              <div>
                <dt>Registered address</dt>
                <dd>{report.corporate_profile.registered_address}</dd>
              </div>
              <div>
                <dt>SIC codes</dt>
                <dd>{report.corporate_profile.sic_codes.join(", ")}</dd>
              </div>
              <div>
                <dt>Accounts due</dt>
                <dd>{report.corporate_profile.accounts_due}</dd>
              </div>
            </dl>
          ) : (
            <div className="subject-profile">
              <p>{report.subject_profile?.headline}</p>
              <p>
                Known for: {report.subject_profile?.known_for.join(", ")}. Locations:{" "}
                {report.subject_profile?.locations.join(", ")}.
              </p>
            </div>
          )}
        </section>

        <section className="report-section">
          <h4>Directors and Officers</h4>
          <div className="stack-list">
            {report.officers.map((officer) => (
              <article
                className="stack-card"
                key={`${officer.name}-${officer.role}-${officer.appointed_on}-${officer.resigned_on || "active"}`}
              >
                <strong>{officer.name}</strong>
                <p>{officer.role}</p>
                <small>
                  Appointed {officer.appointed_on}
                  {officer.resigned_on ? ` | Resigned ${officer.resigned_on}` : ""}
                </small>
              </article>
            ))}
          </div>
        </section>

        <section className="report-section">
          <h4>Ownership and Control</h4>
          {report.pscs.length ? (
            <div className="stack-list">
              {report.pscs.map((psc) => (
                <article className="stack-card" key={`${psc.name}-${psc.kind}`}>
                  <strong>{psc.name}</strong>
                  <p>{psc.kind}</p>
                  <small>
                    Notified {psc.notified_on}
                    {psc.ownership ? ` | ${psc.ownership}` : ""}
                  </small>
                </article>
              ))}
            </div>
          ) : (
            <p className="muted-text">
              No PSC records are surfaced in the current individual flow.
            </p>
          )}
        </section>

        <section className="report-section">
          <h4>PEP and Sanctions Screening</h4>
          <div className="stack-list">
            {report.sanctions_screening.matches.map((match) => (
              <article className="stack-card" key={`${match.dataset}-${match.entity_name}`}>
                <strong>{match.entity_name}</strong>
                <p>{match.dataset}</p>
                <p>{match.detail}</p>
                {match.match_reason ? (
                  <small>
                    Match basis: {match.match_reason}
                  </small>
                ) : null}
                <small>
                  Status: {labelCase(match.status)}
                  {match.match_confidence ? ` | Confidence: ${labelCase(match.match_confidence)}` : ""}
                  {typeof match.score === "number" ? ` | Score: ${match.score.toFixed(3).replace(/\.?0+$/, "")}` : ""}
                </small>
              </article>
            ))}
          </div>
        </section>

        {report.current_status ? (
          <section className="report-section">
            <h4>Current Status</h4>
            <p>{report.current_status.summary}</p>
            {report.current_status.source_labels.length ? (
              <small>
                Based on: {report.current_status.source_labels.join(", ")}
              </small>
            ) : null}
          </section>
        ) : null}

        {report.risk_drivers?.length ? (
          <section className="report-section">
            <h4>Risk Drivers</h4>
            <div className="stack-list">
              {report.risk_drivers.map((driver) => (
                <article className="stack-card" key={`${driver.title}-${driver.detail}`}>
                  <div className="media-header">
                    <strong>{driver.title}</strong>
                    <span className={`severity-pill severity-${driver.severity}`}>{driver.severity}</span>
                  </div>
                  <p>{driver.detail}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="report-section full-span">
          <h4>Media Timeline</h4>
          {mediaTimeline.length ? (
            <div className="timeline-list">
              {mediaTimeline.map((group) => (
                <div className="timeline-group" key={group.label}>
                  <div className="timeline-heading">
                    <span>{group.label}</span>
                  </div>
                  <div className="timeline-items">
                    {group.items.map((item) => (
                      <article
                        className={`timeline-card timeline-${item.timeline_type}`}
                        key={`${item.source_url}-${item.summary}-timeline`}
                      >
                        <div className="timeline-meta">
                          <strong>{item.source_title}</strong>
                          <span className={`severity-pill severity-${item.severity}`}>
                            {item.timeline_type === "adverse" ? "Adverse" : "Positive"}
                          </span>
                        </div>
                        <p>{item.summary}</p>
                        <small>
                          {formatDate(item.date)}
                          {item.verification_status ? ` | ${item.verification_status}` : ""}
                        </small>
                        <a href={item.source_url} target="_blank" rel="noreferrer">
                          View source
                        </a>
                      </article>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="muted-text">No dated media findings are available for this report.</p>
          )}
        </section>

        <section className="report-section full-span">
          <h4>Adverse Media</h4>
          <MediaList items={report.adverse_media} />
        </section>

        <section className="report-section full-span">
          <h4>Positive Media</h4>
          <MediaList items={report.positive_media} />
        </section>

        <section className="report-section">
          <h4>Associations</h4>
          <div className="stack-list">
            {report.associations.map((association) => (
              <article
                className="stack-card"
                key={`${association.subject}-${association.relationship}-${association.source_url}`}
              >
                <strong>{association.subject}</strong>
                <p>{association.relationship}</p>
                {association.match_reason ? (
                  <small>
                    Match basis: {association.match_reason}
                    {association.match_confidence ? ` | ${association.match_confidence}` : ""}
                  </small>
                ) : null}
                <div className="detail-text">
                  <CitedText
                    text={association.detail}
                    citations={[{ url: association.source_url, title: association.subject }]}
                  />
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="report-section">
          <h4>Risk Assessment</h4>
          <div className="risk-grid">
            {Object.entries(report.risk_assessment).map(([category, level]) => (
              <div className="risk-row" key={category}>
                <span>{category.replace("_", " ")}</span>
                <strong className={riskClass(level)}>{riskLabel(level)}</strong>
              </div>
            ))}
          </div>
        </section>

        {report.contradictions?.length ? (
          <section className="report-section">
            <h4>Conflicts and Contradictions</h4>
            <div className="stack-list">
              {report.contradictions.map((item) => (
                <article className="stack-card" key={`${item.topic}-${item.detail}`}>
                  <strong>{item.topic}</strong>
                  <p>{item.detail}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        {report.changes_since_last_run?.length ? (
          <section className="report-section full-span">
            <h4>What Changed Since Last Run</h4>
            <div className="stack-list">
              {report.changes_since_last_run.map((item) => (
                <article className="stack-card" key={item}>
                  <p>{item}</p>
                </article>
              ))}
            </div>
          </section>
        ) : null}

        <section className="report-section full-span">
          <h4>Sources</h4>
          <div className="sources-list">
            {report.sources.filter((source) => source.type !== "background" && source.type !== "alternative").map((source) => (
              <a
                href={source.url}
                key={`${source.url}-${source.accessed_at}`}
                target="_blank"
                rel="noreferrer"
              >
                <strong>{source.title}</strong>
                <span>{source.type.replace("_", " ")}</span>
              </a>
            ))}
          </div>
        </section>

        {alternativeSources.length ? (
          <section className="report-section full-span">
            <h4>Alternative Data</h4>
            {report.alternative_data_summary ? (
              <div className="stack-list">
                <article className="stack-card">
                  <CitedText
                    text={report.alternative_data_summary.text}
                    citations={report.alternative_data_summary.citations}
                  />
                </article>
              </div>
            ) : null}
            <div className="sources-list">
              {alternativeSources.map((source) => (
                <a
                  href={source.url}
                  key={`${source.url}-${source.accessed_at}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <strong>{source.title}</strong>
                  <span>alternative data</span>
                </a>
              ))}
            </div>
          </section>
        ) : null}

        {backgroundSources.length ? (
          <section className="report-section full-span">
            <h4>Background</h4>
            <div className="sources-list">
              {backgroundSources.map((source) => (
                <a
                  href={source.url}
                  key={`${source.url}-${source.accessed_at}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  <strong>{source.title}</strong>
                  <span>background</span>
                </a>
              ))}
            </div>
          </section>
        ) : null}

        <section className="report-section full-span">
          <h4>Source Coverage</h4>
          <div className="coverage-list">
            {sourceCoverage.map((item) => (
              <article className="coverage-row" key={item.label}>
                <div>
                  <strong>{item.label}</strong>
                  <small>{item.detail}</small>
                </div>
                <span className={`coverage-pill ${sourceCoverageClass(item.status)}`}>
                  {sourceCoverageLabel(item.status)}
                </span>
              </article>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export function ReportShell() {
  const [inputMode, setInputMode] = useState<"chat" | "form">("chat");
  const [form, setForm] = useState<ReportRequest>(initialForm);
  const [job, setJob] = useState<ReportJob | null>(null);
  const [status, setStatus] = useState<ReportStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [accessKey, setAccessKey] = useState("");
  const [message, setMessage] = useState("");
  const [activeSubject, setActiveSubject] = useState("");
  const [requestedSubject, setRequestedSubject] = useState("");
  const [resolvedSubject, setResolvedSubject] = useState("");
  const [resolutionConfidence, setResolutionConfidence] = useState<string>("");
  const [pendingConfirmationRequest, setPendingConfirmationRequest] = useState<ReportRequest | null>(null);
  const [chatMessages, setChatMessages] = useState<
    Array<{
      id: string;
      role: "user" | "assistant";
      text: string;
      citations?: Citation[];
    }>
  >([
    {
      id: "welcome",
      role: "assistant",
      text: "Tell me who you want to screen and I’ll start the diligence run.",
    },
  ]);
  const isIndividual = form.subject_type === "individual";
  const isOrganisation = form.subject_type === "organisation";

  useEffect(() => {
    const savedAccessKey = window.localStorage.getItem("opendiligence-access-key");
    if (savedAccessKey) {
      setAccessKey(savedAccessKey);
    }
  }, []);

  useEffect(() => {
    setForm((current) =>
      current.subject_type === "individual"
        ? { ...current, company_number: "" }
        : { ...current, date_of_birth: "" },
    );
  }, [form.subject_type]);

  useEffect(() => {
    if (!job || status?.status === "complete" || status?.status === "failed") {
      return;
    }

    const timer = window.setInterval(async () => {
      const response = await fetch(`/api/reports/${job.report_id}`, {
        headers: accessKey.trim()
          ? {
              "x-opendiligence-key": accessKey.trim(),
            }
          : undefined,
      });
      const data = (await response.json()) as ReportStatusResponse;
      setStatus(data);
    }, 1500);

    return () => window.clearInterval(timer);
  }, [accessKey, job, status?.status]);

  const completedSteps = useMemo(() => {
    if (!status) {
      return 0;
    }

    return Object.values(status.progress).filter((value) => value === "complete").length;
  }, [status]);
  const mediaTriageNote = useMemo(() => getMediaTriageNote(status?.debug_events), [status?.debug_events]);
  const issueEvents = useMemo(() => getIssueEvents(status?.debug_events), [status?.debug_events]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return;
    }

    setIsSubmitting(true);
    setError(null);
    setChatMessages((current) => [
      ...current,
      {
        id: `user-${Date.now()}`,
        role: "user",
        text: trimmedMessage,
      },
    ]);
    setMessage("");

    try {
      window.localStorage.setItem("opendiligence-access-key", accessKey);

      if (pendingConfirmationRequest && isAffirmativeMessage(trimmedMessage)) {
        const response = await fetch("/api/reports", {
          method: "POST",
          headers: buildApiHeaders(accessKey),
          body: JSON.stringify(pendingConfirmationRequest),
        });

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null;
          throw new Error(payload?.error || "Unable to start report generation.");
        }

        const data = (await response.json()) as ReportJob;
        setPendingConfirmationRequest(null);
        setJob(data);
        setStatus(buildPendingStatus(data.report_id));
        setActiveSubject(pendingConfirmationRequest.subject_name);
        setRequestedSubject(pendingConfirmationRequest.subject_name);
        setChatMessages((current) => [
          ...current,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text: `Confirmed. I've started the diligence run for ${pendingConfirmationRequest.subject_name}.`,
          },
        ]);
        window.history.replaceState(null, "", `/?report=${data.report_id}`);
        return;
      }

      if (pendingConfirmationRequest && isNegativeMessage(trimmedMessage)) {
        setPendingConfirmationRequest(null);
        setResolvedSubject("");
        setResolutionConfidence("");
        setChatMessages((current) => [
          ...current,
          {
            id: `assistant-${Date.now()}`,
            role: "assistant",
            text: "Okay. Send the correct subject name or add more context so I can resolve the right person.",
          },
        ]);
        return;
      }

      const response = await fetch("/api/agent", {
        method: "POST",
        headers: buildApiHeaders(accessKey),
        body: JSON.stringify({
          message: trimmedMessage,
          report_id: job?.report_id,
        }),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "Unable to send message to the diligence agent.");
      }

      const data = (await response.json()) as AgentResponse;
      setChatMessages((current) => [
        ...current,
        {
          id: `assistant-${Date.now()}`,
          role: "assistant",
          text: data.message,
          citations: data.citations,
        },
      ]);

      if (data.report_request?.subject_name) {
        setActiveSubject(data.report_request.subject_name);
        setRequestedSubject(data.report_request.subject_name);
      }

      if (data.resolved_subject_name) {
        setResolvedSubject(data.resolved_subject_name);
        setActiveSubject(data.resolved_subject_name);
      }

      if (data.resolution_confidence) {
        setResolutionConfidence(data.resolution_confidence);
      }

      if (data.confirmation_required && data.report_request) {
        setPendingConfirmationRequest(data.report_request);
      } else if (!data.confirmation_required) {
        setPendingConfirmationRequest(null);
      }

      if (data.report_job) {
        setJob(data.report_job);
        setStatus(buildPendingStatus(data.report_job.report_id));
        window.history.replaceState(null, "", `/?report=${data.report_job.report_id}`);
      }

      if (data.report_status) {
        setStatus(data.report_status);
        if (data.report_status.report_id) {
          setJob((current) =>
            current?.report_id === data.report_status?.report_id
              ? current
              : {
                  report_id: data.report_status!.report_id,
                  status: data.report_status!.status,
                  estimated_time_seconds: current?.estimated_time_seconds || 45,
                },
          );
        }
        if (data.report_status.report?.subject_name) {
          setActiveSubject(data.report_status.report.subject_name);
        }
      }
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Something went wrong talking to the diligence agent.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleClassicSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setIsSubmitting(true);
    setError(null);
    setJob(null);
    setStatus(null);
    setActiveSubject(form.subject_name);
    setRequestedSubject(form.subject_name);
    setResolvedSubject("");
    setResolutionConfidence("");

    try {
      window.localStorage.setItem("opendiligence-access-key", accessKey);
      const response = await fetch("/api/reports", {
        method: "POST",
        headers: buildApiHeaders(accessKey),
        body: JSON.stringify(form),
      });

      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(payload?.error || "Unable to start report generation.");
      }

      const data = (await response.json()) as ReportJob;
      setJob(data);
      setStatus(buildPendingStatus(data.report_id));
      window.history.replaceState(null, "", `/?report=${data.report_id}`);
    } catch (submissionError) {
      setError(
        submissionError instanceof Error
          ? submissionError.message
          : "Something went wrong starting the report.",
      );
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <main className="page-shell">
      <section className="hero-card hero-banner">
        <div className="hero-copy">
          <p className="eyebrow">OpenDiligence</p>
          <h1>Source-led diligence reports for people and companies</h1>
          <p className="hero-text">
            Screen corporate records, sanctions, offshore-risk signals, and public-source media,
            then turn the result into a structured report with citations and evidence-aware language.
          </p>
          <div className="hero-links">
            <Link className="hero-link" href="/reports">
              Report history
            </Link>
          </div>
        </div>
        <div className="hero-metrics">
          <div>
            <strong>Coverage</strong>
            <span>Companies House, OpenSanctions, Brave, ICIJ, GLEIF and FCA</span>
          </div>
          <div>
            <strong>Best results</strong>
            <span>Organisation reports are strongest, while people reports improve with DOB and context</span>
          </div>
          <div>
            <strong>Output</strong>
            <span>Executive summary, risk view, officers, associations, media and sources</span>
          </div>
        </div>
      </section>

      <section className="workspace-grid">
        <div className="panel intake-panel">
          <div className="panel-header">
            <div>
              <p className="eyebrow">Workspace</p>
              <h2>{inputMode === "chat" ? "Diligence chat" : "Generate a report"}</h2>
            </div>
          </div>

          <div className="mode-switch" role="tablist" aria-label="Input mode">
            <button
              className={inputMode === "chat" ? "active" : ""}
              type="button"
              onClick={() => setInputMode("chat")}
            >
              Agent chat
            </button>
            <button
              className={inputMode === "form" ? "active" : ""}
              type="button"
              onClick={() => setInputMode("form")}
            >
              Classic form
            </button>
          </div>

          {inputMode === "chat" ? (
            <div className="agent-chat">
              <div className="chat-thread">
                {chatMessages.map((entry) => (
                  <article
                    className={`chat-bubble chat-${entry.role}`}
                    key={entry.id}
                  >
                    <span className="chat-role">
                      {entry.role === "assistant" ? "Agent" : "You"}
                    </span>
                    <p>{entry.text}</p>
                    {entry.citations?.length ? (
                      <div className="chat-citations">
                        {entry.citations.map((citation) => (
                          <a
                            className="inline-citation"
                            href={citation.url}
                            key={`${entry.id}-${citation.url}`}
                            target="_blank"
                            rel="noreferrer"
                            title={citation.title}
                          >
                            {citation.title}
                          </a>
                        ))}
                      </div>
                    ) : null}
                  </article>
                ))}
              </div>

              <form className="intake-form" onSubmit={handleSubmit}>
                <label className="field-block field-block-full">
                  <span className="field-label">Message</span>
                  <textarea
                    rows={5}
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    placeholder="Describe the person or company you want to screen."
                  />
                </label>

                <details className="advanced-toggle">
                  <summary>Advanced</summary>
                  <label className="field-block field-block-full">
                    <span className="field-label">Workspace access key</span>
                    <input
                      type="password"
                      value={accessKey}
                      onChange={(event) => setAccessKey(event.target.value)}
                      placeholder="Optional unless API protection is enabled"
                    />
                  </label>
                </details>

                <div className="intake-actions">
                  <button className="primary-button" disabled={isSubmitting} type="submit">
                    {isSubmitting ? "Thinking..." : job?.report_id ? "Send follow-up" : "Start with agent"}
                  </button>
                  <p className="intake-footnote">
                    {pendingConfirmationRequest
                      ? `Reply "yes" to continue with ${pendingConfirmationRequest.subject_name}, or send a clearer name instead.`
                      : job?.report_id
                      ? `Current report: ${job.report_id}`
                      : "The agent will infer the subject and start the diligence run for you."}
                  </p>
                </div>

                {error ? <p className="error-text">{error}</p> : null}
              </form>
            </div>
          ) : (
            <form className="intake-form" onSubmit={handleClassicSubmit}>
              <label className="field-block field-block-full">
                <span className="field-label">Subject name</span>
                <input
                  required
                  value={form.subject_name}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, subject_name: event.target.value }))
                  }
                  placeholder="Acme Holdings Ltd"
                />
              </label>

              <div className="intake-grid">
                <label className="field-block">
                  <span className="field-label">Subject type</span>
                  <div className="segmented-control">
                    {(["organisation", "individual"] as SubjectType[]).map((type) => (
                      <button
                        key={type}
                        className={form.subject_type === type ? "active" : ""}
                        type="button"
                        onClick={() => setForm((current) => ({ ...current, subject_type: type }))}
                      >
                        {type === "organisation" ? "Organisation" : "Individual"}
                      </button>
                    ))}
                  </div>
                </label>

                <label className="field-block">
                  <span className="field-label">Jurisdiction</span>
                  <select
                    value={form.jurisdiction}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, jurisdiction: event.target.value }))
                    }
                  >
                    {jurisdictionOptions.map((option) => (
                      <option key={option.value || "any"} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="intake-grid">
                <label className={`field-block ${!isOrganisation ? "field-disabled" : ""}`}>
                  <span className="field-label">Company number</span>
                  <span className="field-kicker">Organisation only</span>
                  <input
                    disabled={!isOrganisation}
                    value={form.company_number}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, company_number: event.target.value }))
                    }
                    placeholder="12345678"
                  />
                </label>

                <label className={`field-block ${!isIndividual ? "field-disabled" : ""}`}>
                  <span className="field-label">Date of birth or birth year</span>
                  <span className="field-kicker">Individual only</span>
                  <input
                    disabled={!isIndividual}
                    value={form.date_of_birth}
                    onChange={(event) =>
                      setForm((current) => ({ ...current, date_of_birth: event.target.value }))
                    }
                    placeholder="1980, 1980-05, or 1980-05-12"
                  />
                </label>
              </div>

              <label className="field-block field-block-full">
                <span className="field-label">Additional context</span>
                <textarea
                  rows={4}
                  value={form.additional_context}
                  onChange={(event) =>
                    setForm((current) => ({ ...current, additional_context: event.target.value }))
                  }
                  placeholder="CEO of Acme Ltd, previously at Northgate Group"
                />
              </label>

              <details className="advanced-toggle">
                <summary>Advanced</summary>
                <label className="field-block field-block-full">
                  <span className="field-label">Workspace access key</span>
                  <input
                    type="password"
                    value={accessKey}
                    onChange={(event) => setAccessKey(event.target.value)}
                    placeholder="Optional unless API protection is enabled"
                  />
                </label>
              </details>

              <div className="intake-actions">
                <button className="primary-button" disabled={isSubmitting} type="submit">
                  {isSubmitting ? "Starting..." : "Generate Report"}
                </button>
              </div>

              {error ? <p className="error-text">{error}</p> : null}
            </form>
          )}
        </div>

        <div className="panel progress-surface">
          <div className="panel-header">
            <p className="eyebrow">Pipeline</p>
            <h2>Progress</h2>
          </div>

          {status ? (
            <div className="progress-panel">
              <div className="progress-header">
                <div>
                  <p className="status-label">
                    {status.status === "complete"
                      ? "Report complete"
                      : status.status === "failed"
                        ? "Report failed"
                        : "Processing report"}
                  </p>
                  <h3>{status.report?.subject_name || activeSubject || "New report"}</h3>
                  <p className="progress-subtitle">
                    {status.status === "complete"
                      ? "Every stage has finished and the report is ready to review."
                      : status.status === "failed"
                        ? "The run stopped before a completed report could be assembled."
                        : "The app is moving through records, web research, sanctions screening, and synthesis."}
                  </p>
                </div>
                <div className="progress-count">
                  <strong>{completedSteps}/{stepLabels.length}</strong>
                  <span>Stages complete</span>
                </div>
              </div>

              {(requestedSubject || resolvedSubject) ? (
                <div className="identity-card">
                  <div className="identity-row">
                    <span>Requested</span>
                    <strong>{requestedSubject || activeSubject}</strong>
                  </div>
                  <div className="identity-row">
                    <span>Resolved</span>
                    <strong>{resolvedSubject || status.report?.subject_name || activeSubject}</strong>
                  </div>
                  {resolutionConfidence ? (
                    <div className="identity-row">
                      <span>Confidence</span>
                      <strong>{labelCase(resolutionConfidence)}</strong>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {status.status === "failed" && status.error ? (
                <div className="error-card">
                  <strong>Generation failed</strong>
                  <span>{status.error}</span>
                </div>
              ) : null}

              <div className="step-list">
                {stepLabels.map((step) => (
                  <div className="step-row" key={step.key}>
                    <span className={`step-dot ${status.progress[step.key]}`} />
                    <div>
                      <p>{step.label}</p>
                      <small>{status.progress[step.key].replace("_", " ")}</small>
                    </div>
                  </div>
                ))}
              </div>

              {status.provider_status ? (
                <section className="provider-status-panel">
                  <div className="provider-status-header">
                    <div>
                      <p className="eyebrow">Providers</p>
                      <h4>Live source status</h4>
                    </div>
                    <small>
                      {Object.values(status.provider_status).filter((value) => value === "done").length}/
                      {Object.keys(status.provider_status).length} finished
                    </small>
                  </div>
                  {mediaTriageNote ? (
                    <div className="provider-note">
                      <strong>Media triage</strong>
                      <small>{mediaTriageNote.message}</small>
                    </div>
                  ) : null}
                  <div className="provider-status-grid">
                    {Object.entries(status.provider_status).map(([provider, providerStatus]) => (
                      <article className="provider-status-card" key={provider}>
                        <strong>{providerLabels[provider] || labelCase(provider)}</strong>
                        <span className={`coverage-pill coverage-${providerStatusTone(providerStatus)}`}>
                          {providerStatusLabel(providerStatus)}
                        </span>
                      </article>
                    ))}
                  </div>
                </section>
              ) : null}

              <section className="provider-status-panel diagnostics-panel">
                <div className="provider-status-header">
                  <div>
                    <p className="eyebrow">Diagnostics</p>
                    <h4>What broke or degraded</h4>
                  </div>
                  <small>
                    {issueEvents.length
                      ? `${issueEvents.length} event${issueEvents.length === 1 ? "" : "s"}`
                      : "No issues recorded"}
                  </small>
                </div>
                {issueEvents.length ? (
                  <div className="debug-list">
                    {issueEvents.map((event, index) => (
                      <article className="debug-row" key={`${event.at}-${event.scope}-${index}`}>
                        <div>
                          <strong>{labelCase(event.scope)}</strong>
                          <small>{event.message}</small>
                        </div>
                        <span className={`coverage-pill coverage-${debugTone(event.level)}`}>
                          {labelCase(event.level)}
                        </span>
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="diagnostics-empty">
                    <small>No provider or synthesis failures were recorded for this run.</small>
                  </div>
                )}
              </section>
            </div>
          ) : (
            <div className="empty-state progress-empty">
              <div className="progress-empty-orb" />
              <p>No report running yet.</p>
              <span>
                Ask the agent to screen a person or company and this panel will track the
                orchestration flow from records and public-source research into synthesis.
              </span>
              <div className="progress-preview">
                {stepLabels.map((step) => (
                  <div className="progress-preview-row" key={step.key}>
                    <span className="step-dot" />
                    <small>{step.label}</small>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="panel report-panel">
        <div className="panel-header">
          <div>
            <p className="eyebrow">Report</p>
            <h2>Due diligence output</h2>
          </div>
          {status?.report ? (
            <div className="report-actions">
              <Link className="secondary-link" href={`/reports/${status.report.id}`}>
                Open report page
              </Link>
              <Link className="secondary-link" href="/reports">
                History
              </Link>
            </div>
          ) : null}
        </div>

        {status?.report ? (
          <ReportView report={status.report} />
        ) : status?.status === "failed" ? (
          <ReportErrorState error={status.error} />
        ) : status?.status === "processing" ? (
          <ReportLoadingState />
        ) : (
          <ReportPlaceholder />
        )}
      </section>
    </main>
  );
}

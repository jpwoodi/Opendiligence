import { randomUUID } from "crypto";

import {
  hasBraveSearchConfig,
  hasCompaniesHouseConfig,
  hasOpenAiConfig,
  hasOpenSanctionsConfig,
} from "@/lib/env";
import {
  getPreviousCompletedReportBySubject,
  loadPersistedJobs,
  savePersistedJobs,
} from "@/lib/report-persistence";
import {
  fetchIndividualFromCompaniesHouse,
  fetchOrganisationFromCompaniesHouse,
} from "@/lib/providers/companies-house";
import { researchWithGleif } from "@/lib/providers/gleif";
import { researchWithIcij } from "@/lib/providers/icij-offshore-leaks";
import {
  annotateMediaFindingsForIndividual,
  filterEvidenceForIndividual,
  verifyMediaFindings,
} from "@/lib/providers/media-verification";
import {
  buildSynthesisFallback,
  synthesizeReportWithOpenAi,
} from "@/lib/providers/openai-synthesis";
import { screenWithOpenSanctions } from "@/lib/providers/opensanctions";
import {
  applyUkCurrentRoleToSanctionsMatches,
  fetchUkParliamentCurrentRole,
} from "@/lib/providers/uk-parliament-current-role";
import { researchWithWorldBankDebarments } from "@/lib/providers/world-bank-debarments";
import { withTimeout } from "@/lib/timeout";
import type {
  Citation,
  Contradiction,
  DebugEvent,
  MediaFinding,
  ProviderRunStatus,
  Report,
  ReportJob,
  ReportProgress,
  ReportRequest,
  ReportStatusResponse,
  RiskDriver,
  RiskAssessment,
  RiskLevel,
  SubjectType,
} from "@/lib/types";

type StageKey = keyof ReportProgress;
type ProviderKey =
  | "companies_house"
  | "gleif"
  | "icij"
  | "insolvency_register"
  | "fca_warning_list"
  | "brave_search"
  | "opensanctions"
  | "world_bank_debarments"
  | "analysis";

const PROVIDER_STAGE_MAP: Record<ProviderKey, StageKey> = {
  companies_house: "corporate_records",
  gleif: "corporate_records",
  icij: "corporate_records",
  insolvency_register: "corporate_records",
  fca_warning_list: "corporate_records",
  brave_search: "web_search",
  opensanctions: "sanctions_screening",
  world_bank_debarments: "sanctions_screening",
  analysis: "analysis",
};

const STAGE_PROVIDER_ORDER: Record<StageKey, ProviderKey[]> = {
  corporate_records: ["companies_house", "gleif", "icij", "insolvency_register", "fca_warning_list"],
  web_search: ["brave_search"],
  sanctions_screening: ["opensanctions", "world_bank_debarments"],
  analysis: ["analysis"],
};

const DEFAULT_PROGRESS: ReportProgress = {
  corporate_records: "pending",
  web_search: "pending",
  sanctions_screening: "pending",
  analysis: "pending",
};

const DEFAULT_PROVIDER_STATUS: Record<ProviderKey, ProviderRunStatus> = {
  companies_house: "pending",
  gleif: "pending",
  icij: "pending",
  insolvency_register: "pending",
  fca_warning_list: "pending",
  brave_search: "pending",
  opensanctions: "pending",
  world_bank_debarments: "pending",
  analysis: "pending",
};

interface InternalJob {
  id: string;
  createdAt: number;
  request: ReportRequest;
  progress: ReportProgress;
  providerStatus: Record<ProviderKey, ProviderRunStatus>;
  debugEvents: DebugEvent[];
  report?: Report;
  error?: string;
}

declare global {
  var __openDiligenceJobs: Map<string, InternalJob> | undefined;
}

const jobs = globalThis.__openDiligenceJobs ?? new Map<string, InternalJob>();

if (!globalThis.__openDiligenceJobs) {
  globalThis.__openDiligenceJobs = jobs;
  for (const persistedJob of loadPersistedJobs()) {
    jobs.set(persistedJob.id, {
      ...persistedJob,
      progress: persistedJob.report
        ? {
            corporate_records: "complete",
            web_search: "complete",
            sanctions_screening: "complete",
            analysis: "complete",
          }
        : { ...DEFAULT_PROGRESS },
      providerStatus: {
        ...DEFAULT_PROVIDER_STATUS,
        ...(persistedJob.report
          ? {
              companies_house: "done",
              gleif: "done",
              icij: "done",
              insolvency_register: "done",
              fca_warning_list: "done",
              brave_search: "done",
              opensanctions: "done",
              world_bank_debarments: "done",
              analysis: "done",
            }
          : {}),
      },
      debugEvents: [],
    });
  }
}

function titleCase(value: string) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function buildRiskAssessment(subjectType: SubjectType): RiskAssessment {
  return subjectType === "organisation"
    ? {
        financial_crime: "amber",
        regulatory: "amber",
        esg: "green",
        reputational: "amber",
        sanctions: "green",
        insolvency: "green",
      }
    : {
        financial_crime: "green",
        regulatory: "amber",
        esg: "green",
        reputational: "amber",
        sanctions: "green",
        insolvency: "green",
      };
}

function deriveOverallRisk(risks: RiskAssessment): RiskLevel {
  const levels = Object.values(risks);
  if (levels.includes("red")) {
    return "red";
  }
  if (levels.includes("amber")) {
    return "amber";
  }
  return "green";
}

function maxRiskLevel(left: RiskLevel, right: RiskLevel): RiskLevel {
  const rank: Record<RiskLevel, number> = {
    green: 0,
    amber: 1,
    red: 2,
  };

  return rank[left] >= rank[right] ? left : right;
}

function buildAdverseMedia(name: string): MediaFinding[] {
  return [
    {
      summary: `${name} appeared in coverage discussing internal control weaknesses following a regulatory review, with no criminal finding reported.`,
      risk_category: "regulatory",
      severity: "medium",
      source_url: "https://www.ft.com/content/demo-opendiligence-1",
      source_title: "Financial Times coverage of internal control review",
      date: "2026-02-14",
    },
    {
      summary: `Trade press linked ${name} to supplier concentration concerns and governance scrutiny after rapid expansion into new markets.`,
      risk_category: "reputational",
      severity: "low",
      source_url: "https://www.reuters.com/world/uk/demo-opendiligence-2",
      source_title: "Reuters analysis of governance scrutiny",
      date: "2026-01-22",
    },
  ];
}

function buildPositiveMedia(name: string): MediaFinding[] {
  return [
    {
      summary: `${name} received positive coverage for announcing a compliance refresh and a strengthened board oversight programme.`,
      risk_category: "positive",
      severity: "low",
      source_url: "https://www.bbc.co.uk/news/business-demo-opendiligence",
      source_title: "BBC business profile on compliance refresh",
      date: "2026-03-01",
    },
  ];
}

function buildSources(adverseMedia: MediaFinding[], positiveMedia: MediaFinding[]) {
  const now = new Date().toISOString();

  return [
    {
      url: "https://find-and-update.company-information.service.gov.uk/",
      title: "Companies House",
      type: "corporate_registry" as const,
      accessed_at: now,
    },
    {
      url: "https://www.opensanctions.org/",
      title: "OpenSanctions",
      type: "watchlist" as const,
      accessed_at: now,
    },
    ...adverseMedia.map((item) => ({
      url: item.source_url,
      title: item.source_title,
      type: "news" as const,
      accessed_at: now,
    })),
    ...positiveMedia.map((item) => ({
      url: item.source_url,
      title: item.source_title,
      type: "news" as const,
      accessed_at: now,
    })),
  ];
}

function dedupeSources(sources: Report["sources"]) {
  return sources.filter(
    (source, index, all) => all.findIndex((entry) => entry.url === source.url) === index,
  );
}

function dedupeAssociations(associations: Report["associations"]) {
  const deduped: Report["associations"] = [];

  for (const association of associations) {
    const existing = deduped.find(
      (entry) =>
        entry.subject === association.subject &&
        entry.relationship === association.relationship &&
        entry.source_url === association.source_url,
    );

    if (!existing) {
      deduped.push(association);
      continue;
    }

    existing.match_reason = existing.match_reason || association.match_reason;
    existing.match_confidence = existing.match_confidence || association.match_confidence;
    if (existing.detail.length < association.detail.length) {
      existing.detail = association.detail;
    }
  }

  return deduped;
}

function dedupeMedia(items: Report["adverse_media"]) {
  const deduped: Report["adverse_media"] = [];

  for (const item of items) {
    const existing = deduped.find(
      (entry) =>
        entry.source_url === item.source_url &&
        entry.source_title === item.source_title &&
        entry.risk_category === item.risk_category,
    );

    if (!existing) {
      deduped.push(item);
      continue;
    }

    existing.match_reason = existing.match_reason || item.match_reason;
    existing.match_confidence = existing.match_confidence || item.match_confidence;
    existing.verification_status = existing.verification_status || item.verification_status;
    existing.evidence_spans = existing.evidence_spans || item.evidence_spans;
    if (existing.summary.length < item.summary.length) {
      existing.summary = item.summary;
    }
  }

  return deduped;
}

async function loadBraveSearchProvider() {
  return import("@/lib/providers/brave-search");
}

async function researchWithBraveLazy(request: ReportRequest) {
  const provider = await loadBraveSearchProvider();
  return provider.researchWithBrave(request);
}

async function findingsFromEvidenceLazy(
  evidence: Awaited<ReturnType<typeof researchWithBraveLazy>>["adverseEvidence"],
  riskCategory: string,
  severity: "low" | "medium" | "high",
) {
  const provider = await loadBraveSearchProvider();
  return provider.findingsFromEvidence(evidence, riskCategory, severity);
}

async function researchWithFcaWarningsLazy(request: ReportRequest) {
  const provider = await import("@/lib/providers/fca-warning-list");
  return provider.researchWithFcaWarnings(request);
}

async function researchWithInsolvencyGazetteLazy(request: ReportRequest) {
  const provider = await import("@/lib/providers/insolvency-gazette");
  return provider.researchWithInsolvencyGazette(request);
}

function mergeMatchMetadataIntoSanctions(
  primary: Report["sanctions_screening"]["matches"],
  metadata: Report["sanctions_screening"]["matches"],
) {
  return primary.map((match) => {
    const supporting = metadata.find(
      (entry) => entry.entity_name === match.entity_name && entry.dataset === match.dataset,
    );

    if (!supporting) {
      return match;
    }

    return {
      ...match,
      match_reason: match.match_reason || supporting.match_reason,
      match_confidence: match.match_confidence || supporting.match_confidence,
      office_summary: match.office_summary || supporting.office_summary,
    };
  });
}

function applyRiskEscalation(
  baseline: RiskAssessment,
  input: {
    hasIcijHit?: boolean;
    hasFcaHit?: boolean;
    hasSanctionsHit?: boolean;
  },
): RiskAssessment {
  const next = { ...baseline };

  if (input.hasIcijHit) {
    next.financial_crime = "amber";
    next.reputational = "amber";
  }

  if (input.hasFcaHit) {
    next.regulatory = "red";
    next.reputational = "red";
  }

  if (input.hasSanctionsHit) {
    next.sanctions = "amber";
  }

  return next;
}

function toCitation(source: { url: string; title: string }): Citation {
  return {
    url: source.url,
    title: source.title,
  };
}

function buildExecutiveSummaryCitations(input: {
  companySource?: { url: string; title: string };
  sanctionsSource?: { url: string; title: string };
  mediaSources?: Array<{ url: string; title: string }>;
}) {
  const candidates = [
    input.companySource,
    input.sanctionsSource,
    ...(input.mediaSources || []).slice(0, 2),
  ].filter(Boolean) as Array<{ url: string; title: string }>;

  return candidates.filter(
    (source, index, all) => all.findIndex((entry) => entry.url === source.url) === index,
  ).map(toCitation);
}

function buildRiskDrivers(report: Report): RiskDriver[] {
  const drivers: RiskDriver[] = [];

  const nonClearMatch = report.sanctions_screening.matches.find((match) => match.status !== "clear");
  if (nonClearMatch) {
    drivers.push({
      title: "PEP or sanctions exposure",
      detail: `${nonClearMatch.dataset} returned a ${labelForMatchStatus(nonClearMatch.status)} result${nonClearMatch.office_summary ? ` linked to ${nonClearMatch.office_summary}` : ""}.`,
      severity: nonClearMatch.status === "confirmed_match" ? "high" : "medium",
    });
  }

  const topAdverse = report.adverse_media
    .slice()
    .sort((left, right) => severityRank(right.severity) - severityRank(left.severity))[0];
  if (topAdverse) {
    drivers.push({
      title: "Public-source reputational pressure",
      detail: `${topAdverse.source_title} reported ${topAdverse.risk_category.replace(/_/g, " ")} concerns.`,
      severity: topAdverse.severity,
    });
  }

  if (report.risk_assessment.regulatory !== "green") {
    drivers.push({
      title: "Regulatory sensitivity",
      detail: `Regulatory risk is assessed as ${report.risk_assessment.regulatory} based on screening and source review.`,
      severity: report.risk_assessment.regulatory === "red" ? "high" : "medium",
    });
  }

  if (report.warnings?.some((warning) => warning.toLowerCase().includes("ambiguous"))) {
    drivers.push({
      title: "Identity ambiguity",
      detail: "Some source matches remain identity-sensitive and benefit from stronger disambiguation inputs.",
      severity: "medium",
    });
  }

  return drivers.slice(0, 4);
}

function labelForMatchStatus(status: Report["sanctions_screening"]["matches"][number]["status"]) {
  return status.replace(/_/g, " ");
}

function severityRank(value: MediaFinding["severity"]) {
  return value === "high" ? 3 : value === "medium" ? 2 : 1;
}

function buildCurrentStatus(report: Report) {
  const labels: string[] = [];
  const parts: string[] = [];

  if (report.subject_profile?.headline) {
    parts.push(report.subject_profile.headline);
  } else if (report.corporate_profile) {
    parts.push(`${report.subject_name} is currently recorded as ${report.corporate_profile.status.toLowerCase()} in company records.`);
  }

  if (report.sanctions_screening.status === "clear") {
    parts.push("Current screening does not show a confirmed sanctions match.");
  } else {
    parts.push(`Current screening includes a ${labelForMatchStatus(report.sanctions_screening.status)} result.`);
  }

  for (const source of report.sources) {
    if ((source.type === "regulatory" || source.type === "corporate_registry" || source.type === "watchlist") && !labels.includes(source.title)) {
      labels.push(source.title);
    }
  }

  return {
    summary: parts.join(" "),
    source_labels: labels.slice(0, 4),
  };
}

function buildContradictions(report: Report): Contradiction[] {
  const contradictions: Contradiction[] = [];

  const positive = report.positive_media[0];
  const adverse = report.adverse_media[0];
  if (positive && adverse) {
    contradictions.push({
      topic: "Mixed public narrative",
      detail: `Public coverage includes both positive reporting (${positive.source_title}) and adverse or critical reporting (${adverse.source_title}).`,
    });
  }

  if (report.warnings?.some((warning) => warning.toLowerCase().includes("fallback"))) {
    contradictions.push({
      topic: "Coverage completeness",
      detail: "Some sections used fallback or partial-source logic, so the overall picture may not be fully complete.",
    });
  }

  return contradictions;
}

function buildChangesSinceLastRun(report: Report) {
  const previous = getPreviousCompletedReportBySubject({
    subjectName: report.subject_name,
    subjectType: report.subject_type,
    excludeReportId: report.id,
  });

  if (!previous) {
    return ["No prior completed report is available for comparison."];
  }

  const changes: string[] = [];

  if (previous.executive_summary.overall_risk !== report.executive_summary.overall_risk) {
    changes.push(
      `Overall risk changed from ${previous.executive_summary.overall_risk} to ${report.executive_summary.overall_risk}.`,
    );
  }

  const previousAdverseUrls = new Set(previous.adverse_media.map((item) => item.source_url));
  const newAdverse = report.adverse_media.filter((item) => !previousAdverseUrls.has(item.source_url));
  if (newAdverse.length) {
    changes.push(`${newAdverse.length} new adverse media item${newAdverse.length === 1 ? "" : "s"} appeared since the last completed run.`);
  }

  const previousPositiveUrls = new Set(previous.positive_media.map((item) => item.source_url));
  const newPositive = report.positive_media.filter((item) => !previousPositiveUrls.has(item.source_url));
  if (newPositive.length) {
    changes.push(`${newPositive.length} new positive media item${newPositive.length === 1 ? "" : "s"} appeared since the last completed run.`);
  }

  if (previous.sanctions_screening.status !== report.sanctions_screening.status) {
    changes.push(
      `Screening status changed from ${labelForMatchStatus(previous.sanctions_screening.status)} to ${labelForMatchStatus(report.sanctions_screening.status)}.`,
    );
  }

  return changes.length ? changes : ["No material change was detected versus the last completed run."];
}

function enrichDerivedSections(report: Report): Report {
  return {
    ...report,
    risk_drivers: buildRiskDrivers(report),
    current_status: buildCurrentStatus(report),
    contradictions: buildContradictions(report),
    changes_since_last_run: buildChangesSinceLastRun(report),
  };
}

function persistJobs() {
  savePersistedJobs([...jobs.values()]);
}

function createInitialProgress(): ReportProgress {
  return {
    corporate_records: "in_progress",
    web_search: "pending",
    sanctions_screening: "pending",
    analysis: "pending",
  };
}

function createInitialProviderStatus(): Record<ProviderKey, ProviderRunStatus> {
  return { ...DEFAULT_PROVIDER_STATUS };
}

function recordDebug(jobId: string, event: Omit<DebugEvent, "at">) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.debugEvents.unshift({
    ...event,
    at: new Date().toISOString(),
  });
  job.debugEvents = job.debugEvents.slice(0, 25);
  persistJobs();
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function setStageState(job: InternalJob, stage: StageKey, state: ReportProgress[StageKey]) {
  job.progress[stage] = state;
}

function refreshStageState(job: InternalJob, stage: StageKey) {
  const statuses = STAGE_PROVIDER_ORDER[stage].map((provider) => job.providerStatus[provider]);

  if (statuses.every((status) => status === "pending")) {
    job.progress[stage] = "pending";
    return;
  }

  if (statuses.every((status) => status === "done" || status === "error")) {
    job.progress[stage] = "complete";
    return;
  }

  job.progress[stage] = "in_progress";
}

function setProviderStatus(jobId: string, provider: ProviderKey, status: ProviderRunStatus) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.providerStatus[provider] = status;
  refreshStageState(job, PROVIDER_STAGE_MAP[provider]);
  persistJobs();
}

async function runProvider<T>(
  jobId: string,
  provider: ProviderKey,
  task: () => Promise<T>,
): Promise<T> {
  setProviderStatus(jobId, provider, "running");

  try {
    const result = await task();
    setProviderStatus(jobId, provider, "done");
    return result;
  } catch (error) {
    setProviderStatus(jobId, provider, "error");
    recordDebug(jobId, {
      scope: provider,
      level: "error",
      message: `${labelForProvider(provider)} failed: ${getErrorMessage(error)}`,
    });
    throw error;
  }
}

function labelForProvider(provider: ProviderKey) {
  return titleCase(provider.replaceAll("_", " "));
}

function startStage(jobId: string, stage: StageKey) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  setStageState(job, stage, "in_progress");
  persistJobs();
}

function markComplete(jobId: string) {
  const job = jobs.get(jobId);

  if (!job) {
    return;
  }

  job.providerStatus = {
    companies_house:
      job.providerStatus.companies_house === "error" ? "error" : "done",
    gleif: job.providerStatus.gleif === "error" ? "error" : "done",
    icij: job.providerStatus.icij === "error" ? "error" : "done",
    insolvency_register:
      job.providerStatus.insolvency_register === "error" ? "error" : "done",
    fca_warning_list:
      job.providerStatus.fca_warning_list === "error" ? "error" : "done",
    brave_search: job.providerStatus.brave_search === "error" ? "error" : "done",
    opensanctions: job.providerStatus.opensanctions === "error" ? "error" : "done",
    world_bank_debarments:
      job.providerStatus.world_bank_debarments === "error" ? "error" : "done",
    analysis: job.providerStatus.analysis === "error" ? "error" : "done",
  };
  job.progress = {
    corporate_records: "complete",
    web_search: "complete",
    sanctions_screening: "complete",
    analysis: "complete",
  };
}

function normaliseSubjectName(request: ReportRequest) {
  return request.subject_name.trim();
}

function buildSeededReport(id: string, request: ReportRequest): Report {
  const subjectName = normaliseSubjectName(request);
  const risks = buildRiskAssessment(request.subject_type);
  const overallRisk = deriveOverallRisk(risks);
  const adverseMedia = buildAdverseMedia(subjectName);
  const positiveMedia = buildPositiveMedia(subjectName);

  const baseReport: Report = {
    id,
    subject_name: subjectName,
    subject_type: request.subject_type,
    created_at: new Date().toISOString(),
    status: "complete",
    warnings: [],
    executive_summary: {
      text:
        request.subject_type === "organisation"
          ? `${subjectName} is presented as an active entity with identifiable control and management information, no confirmed sanctions match, and a limited set of regulatory and reputational flags that warrant follow-up review. The overall picture is consistent with an amber diligence outcome driven by governance questions rather than evidence of financial crime.`
          : `${subjectName} is presented as an identifiable individual with corroborated professional context, no confirmed sanctions hit, and a modest level of reputational and regulatory sensitivity from public reporting. The current profile supports an amber diligence outcome pending manual review of context-specific adverse media.`,
      overall_risk: overallRisk,
      citations: buildExecutiveSummaryCitations({
        companySource: {
          url: "https://find-and-update.company-information.service.gov.uk/",
          title: "Companies House",
        },
        sanctionsSource: {
          url: "https://www.opensanctions.org/",
          title: "OpenSanctions",
        },
        mediaSources: buildSources(adverseMedia, positiveMedia).filter((source) => source.type === "news"),
      }),
    },
    officers:
      request.subject_type === "organisation"
        ? [
            {
              name: "Alex Mercer",
              role: "Director",
              appointed_on: "2022-07-08",
            },
            {
              name: "Jordan Pike",
              role: "Director",
              appointed_on: "2021-11-02",
            },
          ]
        : [
            {
              name: subjectName,
              role: "Director, Northgate Advisory Ltd",
              appointed_on: "2023-05-11",
            },
            {
              name: subjectName,
              role: "Former Board Adviser, Meridian Ventures",
              appointed_on: "2020-03-19",
              resigned_on: "2022-12-16",
            },
          ],
    pscs:
      request.subject_type === "organisation"
        ? [
            {
              name: "North Star Holdings Limited",
              kind: "Corporate PSC",
              notified_on: "2022-07-10",
              ownership: "75% or more",
            },
            {
              name: "Alex Mercer",
              kind: "Individual PSC",
              notified_on: "2022-07-10",
              ownership: "25% to 50%",
            },
          ]
        : [],
    sanctions_screening: {
      matches: [
        {
          entity_name: subjectName,
          dataset: "UK Sanctions List",
          score: 0.11,
          status: "clear",
          detail: "No meaningful match identified in the seeded screening pass.",
        },
      ],
      lists_checked: 1487,
      status: "clear",
    },
    adverse_media: adverseMedia,
    positive_media: positiveMedia,
    associations:
      request.subject_type === "organisation"
        ? [
            {
              subject: "North Star Holdings Limited",
              relationship: "Controlling shareholder",
              detail: "Appears as the majority PSC and likely upstream holding entity.",
              source_url: "https://find-and-update.company-information.service.gov.uk/",
            },
            {
              subject: "Alex Mercer",
              relationship: "Director and minority controller",
              detail: "Listed as a board member and individual PSC in the seeded profile.",
              source_url: "https://find-and-update.company-information.service.gov.uk/",
            },
          ]
        : [
            {
              subject: "Northgate Advisory Ltd",
              relationship: "Current directorship",
              detail: "Public corporate records indicate an active leadership role.",
              source_url: "https://find-and-update.company-information.service.gov.uk/",
            },
          ],
    risk_assessment: risks,
    sources: buildSources(adverseMedia, positiveMedia),
  };

  if (request.subject_type === "organisation") {
    baseReport.corporate_profile = {
      company_number: request.company_number || "14839271",
      status: "Active",
      type: "Private limited company",
      sic_codes: ["62020", "70229"],
      registered_address: "12 Bishopsgate, London, EC2N 4AY, United Kingdom",
      incorporated: "2022-07-08",
      accounts_due: "2026-09-30",
    };
  } else {
    baseReport.subject_profile = {
      headline: `${subjectName} is presented as a UK-based executive with recent board and advisory roles.`,
      known_for: ["Corporate advisory work", "Board leadership", "Growth-stage oversight"],
      locations: [request.jurisdiction?.toUpperCase() || "UK", "London"],
    };
  }

  return baseReport;
}

function buildSparseIndividualReport(id: string, request: ReportRequest): Report {
  const subjectName = normaliseSubjectName(request);

  return {
    id,
    subject_name: subjectName,
    subject_type: request.subject_type,
    created_at: new Date().toISOString(),
    status: "complete",
    warnings: [],
    executive_summary: {
      text: `${subjectName} could not be linked to a reliable Companies House officer record from the current inputs, so the report excludes placeholder appointment data and relies only on other live sources.`,
      overall_risk: "amber",
      citations: [],
    },
    subject_profile: {
      headline: `${subjectName} could not be confidently resolved to a specific Companies House officer record.`,
      known_for: ["Resolution requires stronger identity signals"],
      locations: [request.jurisdiction?.toUpperCase() || "Unknown"],
    },
    officers: [],
    pscs: [],
    sanctions_screening: {
      matches: [],
      lists_checked: 0,
      status: "clear",
    },
    adverse_media: [],
    positive_media: [],
    associations: [],
    risk_assessment: buildRiskAssessment("individual"),
    sources: [],
  };
}

async function buildReport(id: string, request: ReportRequest): Promise<Report> {
  const subjectName = normaliseSubjectName(request);
  const enrichmentResults = await Promise.all([
    runProvider(id, "icij", () =>
      withTimeout(researchWithIcij(request), 12000, "ICIJ offshore leaks"),
    ).catch(() => null),
    runProvider(id, "gleif", () =>
      withTimeout(researchWithGleif(request), 12000, "GLEIF enrichment"),
    ).catch(() => null),
    runProvider(id, "insolvency_register", () =>
      withTimeout(researchWithInsolvencyGazetteLazy(request), 12000, "Insolvency Gazette screening"),
    ).catch(() => null),
    runProvider(id, "fca_warning_list", () =>
      withTimeout(researchWithFcaWarningsLazy(request), 12000, "FCA warning list"),
    ).catch(() => null),
  ]);
  const [icijData, gleifData, insolvencyData, fcaData] = enrichmentResults;
  if (fcaData?.unavailable) {
    recordDebug(id, {
      scope: "fca_warning_list",
      level: "warning",
      message: "FCA Warning List was unavailable from the hosted runtime, so this source was skipped for the current run.",
    });
  }
  const ukCurrentRole =
    request.subject_type === "individual"
      ? await withTimeout(
          fetchUkParliamentCurrentRole(request),
          12000,
          "UK Parliament current role lookup",
        ).catch(() => null)
      : null;
  const baselineRisks = applyRiskEscalation(buildRiskAssessment(request.subject_type), {
    hasIcijHit: Boolean(icijData?.associations.length),
    hasFcaHit: Boolean(fcaData?.adverseMedia.length),
    hasSanctionsHit: false,
  });
  baselineRisks.insolvency = insolvencyData?.riskLevel || baselineRisks.insolvency;
  const seededAdverseMedia = buildAdverseMedia(subjectName);
  const seededPositiveMedia = buildPositiveMedia(subjectName);
  const seededSanctions = {
    matches: [
      {
        entity_name: subjectName,
        dataset: "UK Sanctions List",
        score: 0.11,
        status: "clear" as const,
        detail: "No meaningful match identified in the seeded screening pass.",
      },
    ],
    lists_checked: 1487,
    status: "clear" as const,
    sources: [
      {
        url: "https://www.opensanctions.org/",
        title: "OpenSanctions",
        type: "watchlist" as const,
        accessed_at: new Date().toISOString(),
      },
    ],
  };

  startStage(id, "web_search");
  const liveMedia = hasBraveSearchConfig()
    ? await runProvider(id, "brave_search", () =>
        withTimeout(researchWithBraveLazy(request), 45000, "Media research"),
      )
        .then((result) => {
          recordDebug(id, {
            scope: "brave_search",
            level: "info",
            message:
              result.triageMode === "llm"
                ? "Media triage used the LLM to classify broad news candidates."
                : "Media triage used heuristic filtering because LLM triage was unavailable.",
          });
          return result;
        })
        .catch(() => null)
    : (setProviderStatus(id, "brave_search", "done"),
      recordDebug(id, {
        scope: "brave_search",
        level: "warning",
        message: "Brave Search is not configured, so media research used fallback/demo data.",
      }),
      null);

  startStage(id, "sanctions_screening");
  const liveSanctions = hasOpenSanctionsConfig()
    ? await runProvider(id, "opensanctions", () =>
        withTimeout(screenWithOpenSanctions(request), 12000, "Sanctions screening"),
      ).catch(() => null)
    : (setProviderStatus(id, "opensanctions", "done"),
      recordDebug(id, {
        scope: "opensanctions",
        level: "warning",
        message: "OpenSanctions is not configured, so sanctions screening used fallback/demo data.",
      }),
      null);
  const worldBankDebarments = await runProvider(id, "world_bank_debarments", () =>
    withTimeout(
      researchWithWorldBankDebarments(request),
      12000,
      "World Bank Debarments screening",
    ),
  ).catch(() => null);

  const sanctionsMatches = [
    ...(liveSanctions?.matches || seededSanctions.matches),
    ...(worldBankDebarments?.matches || []),
  ];
  const normalizedSanctionsMatches = ukCurrentRole?.officeSummary
    ? applyUkCurrentRoleToSanctionsMatches(
        sanctionsMatches,
        request.subject_name,
        ukCurrentRole.officeSummary,
      )
    : sanctionsMatches;
  const sanctionsStatus = sanctionsMatches.some((match) => match.status === "confirmed_match")
    ? "confirmed_match"
    : sanctionsMatches.some((match) => match.status === "potential_match")
      ? "potential_match"
      : (liveSanctions?.status || seededSanctions.status);
  const sanctionsScreening = (liveSanctions || worldBankDebarments)
    ? {
        matches: normalizedSanctionsMatches,
        lists_checked: (liveSanctions?.listsChecked || seededSanctions.lists_checked) + (worldBankDebarments ? 1 : 0),
        status: sanctionsStatus,
      }
    : {
        matches: normalizedSanctionsMatches,
        lists_checked: seededSanctions.lists_checked,
        status: seededSanctions.status,
      };
  baselineRisks.sanctions =
    sanctionsScreening.status === "confirmed_match"
      ? "red"
      : sanctionsScreening.status === "potential_match"
        ? "amber"
        : baselineRisks.sanctions;
  if (worldBankDebarments?.riskLevel) {
    baselineRisks.regulatory = maxRiskLevel(baselineRisks.regulatory, worldBankDebarments.riskLevel);
    baselineRisks.financial_crime = maxRiskLevel(
      baselineRisks.financial_crime,
      worldBankDebarments.riskLevel === "red" ? "red" : "amber",
    );
  }
  const adverseMedia = dedupeMedia([
    ...(liveMedia?.adverseMedia.length ? liveMedia.adverseMedia : seededAdverseMedia),
    ...(insolvencyData?.findings || []),
    ...(icijData?.adverseMedia || []),
    ...(fcaData?.adverseMedia || []),
  ]);
  const positiveMedia = liveMedia?.positiveMedia.length ? liveMedia.positiveMedia : seededPositiveMedia;
  const mediaSources = dedupeSources([
    ...(liveMedia?.sources || buildSources(adverseMedia, positiveMedia).filter((source) => source.type === "news")),
    ...(liveMedia?.alternativeSources || []),
    ...(insolvencyData?.sources || []),
    ...(icijData?.sources || []),
    ...(fcaData?.sources || []),
  ]);
  const adverseEvidence = liveMedia?.adverseEvidence || [];
  const positiveEvidence = liveMedia?.positiveEvidence || [];
  const warnings: string[] = [];

  if (!liveSanctions) {
    warnings.push("Sanctions screening fell back to seeded/demo data.");
  }
  if (!worldBankDebarments) {
    warnings.push("World Bank Debarments screening could not be completed.");
  }
  if (!liveMedia) {
    warnings.push("Media research fell back to seeded/demo data.");
  }
  if (!insolvencyData) {
    warnings.push("Insolvency screening could not be completed from the live Gazette source.");
  }
  if (fcaData?.unavailable) {
    warnings.push("FCA Warning List was temporarily unavailable from the hosted runtime and was skipped.");
  }

  if (request.subject_type === "individual" && hasCompaniesHouseConfig()) {
    try {
      const individualData = await runProvider(id, "companies_house", () =>
        withTimeout(
          fetchIndividualFromCompaniesHouse(request),
          22000,
          "Individual Companies House lookup",
        ),
      );
      const referenceTerms = [
        ukCurrentRole?.officeSummary || "",
        ...individualData.subjectProfile.locations,
        ...individualData.associations.map((association) => association.subject),
        request.additional_context || "",
      ];
      const enrichedSubjectProfile = ukCurrentRole
        ? {
            ...individualData.subjectProfile,
            headline: ukCurrentRole.subjectProfile.headline,
            known_for: [
              ...ukCurrentRole.subjectProfile.known_for,
              ...individualData.subjectProfile.known_for,
            ].filter((value, index, all) => all.indexOf(value) === index),
            locations: [
              ...ukCurrentRole.subjectProfile.locations,
              ...individualData.subjectProfile.locations,
            ].filter((value, index, all) => all.indexOf(value) === index),
          }
        : individualData.subjectProfile;
      const filteredAdverseEvidence = liveMedia
        ? filterEvidenceForIndividual({
            requestName: request.subject_name,
            canonicalName: individualData.subjectName,
            evidence: adverseEvidence,
            referenceTerms,
          })
        : adverseEvidence;
      const filteredPositiveEvidence = liveMedia
        ? filterEvidenceForIndividual({
            requestName: request.subject_name,
            canonicalName: individualData.subjectName,
            evidence: positiveEvidence,
            referenceTerms,
          })
        : positiveEvidence;
      const adverseMediaForSubject = filteredAdverseEvidence.length
        ? annotateMediaFindingsForIndividual({
            requestName: request.subject_name,
            canonicalName: individualData.subjectName,
            findings: await findingsFromEvidenceLazy(filteredAdverseEvidence, "adverse_media", "medium"),
            evidence: filteredAdverseEvidence,
            referenceTerms,
          })
        : [];
      const positiveMediaForSubject = filteredPositiveEvidence.length
        ? annotateMediaFindingsForIndividual({
            requestName: request.subject_name,
            canonicalName: individualData.subjectName,
            findings: await findingsFromEvidenceLazy(filteredPositiveEvidence, "positive_media", "low"),
            evidence: filteredPositiveEvidence,
            referenceTerms,
          })
        : [];
      const subjectMediaSources = [...filteredAdverseEvidence, ...filteredPositiveEvidence].map(
        (source) => ({
          url: source.url,
          title: source.title,
        }),
      );

      if (liveMedia && adverseEvidence.length > filteredAdverseEvidence.length) {
        warnings.push("Some adverse media results were excluded after person-level name disambiguation.");
      }
      if (liveMedia && positiveEvidence.length > filteredPositiveEvidence.length) {
        warnings.push("Some positive media results were excluded after person-level name disambiguation.");
      }
      if (individualData.warnings?.length) {
        warnings.push(...individualData.warnings);
      }
      const individualInsolvencyFindings = insolvencyData?.findings || [];
      startStage(id, "analysis");
      const synthesized = hasOpenAiConfig()
        ? await runProvider(id, "analysis", () =>
            withTimeout(synthesizeReportWithOpenAi({
              request,
              subjectName: individualData.subjectName,
              subjectProfile: enrichedSubjectProfile,
              officers: individualData.officers,
              pscs: [],
              sanctionsMatches: sanctionsScreening.matches,
              adverseMedia: dedupeMedia([
                ...adverseMediaForSubject,
                ...individualInsolvencyFindings,
              ]),
              positiveMedia: positiveMediaForSubject,
              adverseEvidence: filteredAdverseEvidence,
              positiveEvidence: filteredPositiveEvidence,
              associations: dedupeAssociations([
                ...individualData.associations,
                ...(icijData?.associations || []),
              ]),
            }), 45000, "Live individual synthesis")
          ).catch((error) => {
            setProviderStatus(id, "analysis", "done");
            warnings.push("Executive summary and synthesis used fallback output because AI synthesis failed.");
            recordDebug(id, {
              scope: "analysis",
              level: "warning",
              message: `Live individual synthesis failed, so the report used fallback synthesis. Reason: ${getErrorMessage(error)}`,
            });
            return buildSynthesisFallback({
              request,
              subjectName: individualData.subjectName,
              sanctionsMatches: sanctionsScreening.matches,
              adverseMedia: dedupeMedia([
                ...adverseMediaForSubject,
                ...individualInsolvencyFindings,
              ]),
              positiveMedia: positiveMediaForSubject,
              associations: dedupeAssociations([
                ...individualData.associations,
                ...(icijData?.associations || []),
              ]),
              riskAssessment: baselineRisks,
            });
          })
        : (setProviderStatus(id, "analysis", "done"),
          warnings.push("Executive summary and synthesis used fallback output because AI synthesis is not configured."),
          recordDebug(id, {
            scope: "analysis",
            level: "warning",
            message: "OpenAI is not configured, so the report used fallback synthesis.",
          }),
          buildSynthesisFallback({
            request,
            subjectName: individualData.subjectName,
            sanctionsMatches: sanctionsScreening.matches,
            adverseMedia: dedupeMedia([
              ...adverseMediaForSubject,
              ...individualInsolvencyFindings,
            ]),
            positiveMedia: positiveMediaForSubject,
            associations: dedupeAssociations([
              ...individualData.associations,
              ...(icijData?.associations || []),
            ]),
            riskAssessment: baselineRisks,
          }));
      const resolvedRiskAssessment = {
        ...synthesized.risk_assessment,
        insolvency: maxRiskLevel(
          synthesized.risk_assessment.insolvency,
          insolvencyData?.riskLevel || "green",
        ),
      };
      const overallRisk = deriveOverallRisk(resolvedRiskAssessment);
      const verifiedAdverseMedia = annotateMediaFindingsForIndividual({
        requestName: request.subject_name,
        canonicalName: individualData.subjectName,
        findings: verifyMediaFindings(synthesized.adverse_media, filteredAdverseEvidence),
        evidence: filteredAdverseEvidence,
        referenceTerms,
      });
      const verifiedPositiveMedia = annotateMediaFindingsForIndividual({
        requestName: request.subject_name,
        canonicalName: individualData.subjectName,
        findings: verifyMediaFindings(synthesized.positive_media, filteredPositiveEvidence),
        evidence: filteredPositiveEvidence,
        referenceTerms,
      });
      const enrichedAssociations = dedupeAssociations([
        ...individualData.associations,
        ...(icijData?.associations || []),
        ...synthesized.associations,
      ]);
      const enrichedSanctions = mergeMatchMetadataIntoSanctions(
        sanctionsScreening.matches,
        liveSanctions?.matches || seededSanctions.matches,
      );

      return {
        id,
        subject_name: individualData.subjectName,
        subject_type: request.subject_type,
        created_at: new Date().toISOString(),
        status: "complete",
        warnings,
        executive_summary: {
          ...synthesized.executive_summary,
          overall_risk: overallRisk,
          citations: buildExecutiveSummaryCitations({
            companySource: individualData.sources[0],
            sanctionsSource: (liveSanctions?.sources || seededSanctions.sources)[0],
            mediaSources: subjectMediaSources,
          }),
        },
        subject_profile: enrichedSubjectProfile,
        officers: individualData.officers,
        pscs: [],
        sanctions_screening: {
          ...sanctionsScreening,
          matches: enrichedSanctions,
        },
        adverse_media: dedupeMedia([
          ...individualInsolvencyFindings,
          ...adverseMediaForSubject,
          ...verifiedAdverseMedia,
        ]),
        positive_media: dedupeMedia([...positiveMediaForSubject, ...verifiedPositiveMedia]),
        associations: enrichedAssociations,
        risk_assessment: resolvedRiskAssessment,
        alternative_data_summary: liveMedia?.alternativeDataSummary,
        sources: dedupeSources([
          ...individualData.sources,
          ...(ukCurrentRole?.sources || []),
          ...(liveSanctions?.sources || seededSanctions.sources),
          ...(worldBankDebarments?.sources || []),
          ...(insolvencyData?.sources || []),
          ...(icijData?.sources || []),
          ...(fcaData?.sources || []),
          ...subjectMediaSources.map((source) => ({
            url: source.url,
            title: source.title,
            type: "news" as const,
            accessed_at: new Date().toISOString(),
          })),
        ]),
      };
    } catch {
      warnings.push(
        "Individual Companies House lookup failed, so appointment data is omitted rather than replaced with placeholder records.",
      );
      setProviderStatus(id, "companies_house", "error");
    }
  }

  if (request.subject_type !== "organisation" || !hasCompaniesHouseConfig()) {
    setProviderStatus(id, "companies_house", "done");
    if (!hasCompaniesHouseConfig()) {
      recordDebug(id, {
        scope: "companies_house",
        level: "warning",
        message: "Companies House is not configured, so corporate registry data used fallback/demo data.",
      });
    }
    const report =
      request.subject_type === "individual"
        ? buildSparseIndividualReport(id, request)
        : buildSeededReport(id, request);
    if (request.subject_type === "organisation") {
      warnings.push("Corporate registry data fell back to seeded/demo data.");
    } else {
      warnings.push(
        "Individual appointment data is unavailable from Companies House, so no placeholder officer records were added.",
      );
    }
    startStage(id, "analysis");
    const synthesized = hasOpenAiConfig()
      ? await runProvider(id, "analysis", () =>
          withTimeout(synthesizeReportWithOpenAi({
            request,
            subjectName: report.subject_name,
            corporateProfile: report.corporate_profile,
            subjectProfile: report.subject_profile,
            officers: report.officers,
            pscs: report.pscs,
            sanctionsMatches: sanctionsScreening.matches,
            adverseMedia,
            positiveMedia,
            adverseEvidence,
            positiveEvidence,
            associations: report.associations,
          }), 45000, "Fallback-path synthesis")
        ).catch((error) => {
          setProviderStatus(id, "analysis", "done");
          warnings.push("Executive summary and synthesis used fallback output because AI synthesis failed.");
          recordDebug(id, {
            scope: "analysis",
            level: "warning",
            message: `Fallback-path synthesis failed, so the report used fallback synthesis. Reason: ${getErrorMessage(error)}`,
          });
          return buildSynthesisFallback({
            request,
            subjectName: report.subject_name,
            sanctionsMatches: sanctionsScreening.matches,
            adverseMedia,
            positiveMedia,
            associations: dedupeAssociations([
              ...report.associations,
              ...(icijData?.associations || []),
              ...(gleifData?.associations || []),
            ]),
            riskAssessment: baselineRisks,
          });
        })
      : (setProviderStatus(id, "analysis", "done"),
        warnings.push("Executive summary and synthesis used fallback output because AI synthesis is not configured."),
        recordDebug(id, {
          scope: "analysis",
          level: "warning",
          message: "OpenAI is not configured, so the report used fallback synthesis.",
        }),
        buildSynthesisFallback({
          request,
          subjectName: report.subject_name,
          sanctionsMatches: sanctionsScreening.matches,
          adverseMedia,
          positiveMedia,
          associations: dedupeAssociations([
            ...report.associations,
            ...(icijData?.associations || []),
            ...(gleifData?.associations || []),
          ]),
          riskAssessment: baselineRisks,
        }));

    report.executive_summary = synthesized.executive_summary;
    report.executive_summary.citations = buildExecutiveSummaryCitations({
      sanctionsSource: (liveSanctions?.sources || seededSanctions.sources)[0],
      mediaSources,
    });
    report.risk_assessment = {
      ...synthesized.risk_assessment,
      insolvency: maxRiskLevel(
        synthesized.risk_assessment.insolvency,
        insolvencyData?.riskLevel || "green",
      ),
    };
    report.sanctions_screening = sanctionsScreening;
    report.adverse_media = dedupeMedia([
      ...(insolvencyData?.findings || []),
      ...verifyMediaFindings(synthesized.adverse_media, adverseEvidence),
    ]);
    report.positive_media = verifyMediaFindings(synthesized.positive_media, positiveEvidence);
    report.associations = dedupeAssociations([
      ...report.associations,
      ...(icijData?.associations || []),
      ...(gleifData?.associations || []),
      ...synthesized.associations,
    ]);
    report.warnings = warnings;
    report.alternative_data_summary = liveMedia?.alternativeDataSummary;
    report.sources = [
      ...report.sources.filter((source) => source.type !== "watchlist"),
      ...(liveSanctions?.sources || seededSanctions.sources),
      ...(worldBankDebarments?.sources || []),
      ...mediaSources,
      ...(icijData?.sources || []),
      ...(gleifData?.sources || []),
      ...(fcaData?.sources || []),
    ];
    report.sources = dedupeSources(report.sources);
    return report;
  }

  try {
    const companyData = await runProvider(id, "companies_house", () =>
      withTimeout(
        fetchOrganisationFromCompaniesHouse(request),
        22000,
        "Organisation Companies House lookup",
      ),
    );
    const baseAssociations = companyData.pscs.slice(0, 2).map((psc) => ({
      subject: psc.name,
      relationship: "Person with significant control",
      detail: psc.ownership
        ? `Control indicator: ${psc.ownership}.`
        : "Control relationship surfaced via Companies House PSC data.",
      source_url: companyData.sources[0]?.url || "https://find-and-update.company-information.service.gov.uk/",
    }));
    const enrichedAssociations = dedupeAssociations([
      ...baseAssociations,
      ...(icijData?.associations || []),
      ...(gleifData?.associations || []),
    ]);
    startStage(id, "analysis");
    const synthesized = hasOpenAiConfig()
      ? await runProvider(id, "analysis", () =>
          withTimeout(synthesizeReportWithOpenAi({
            request,
            subjectName: companyData.subjectName,
            corporateProfile: companyData.corporateProfile,
            officers: companyData.officers,
            pscs: companyData.pscs,
            sanctionsMatches: sanctionsScreening.matches,
            adverseMedia,
            positiveMedia,
            adverseEvidence,
            positiveEvidence,
            associations: enrichedAssociations,
          }), 45000, "Live organisation synthesis")
        ).catch((error) => {
          setProviderStatus(id, "analysis", "done");
          warnings.push("Executive summary and synthesis used fallback output because AI synthesis failed.");
          recordDebug(id, {
            scope: "analysis",
            level: "warning",
            message: `Live organisation synthesis failed, so the report used fallback synthesis. Reason: ${getErrorMessage(error)}`,
          });
          return buildSynthesisFallback({
            request,
            subjectName: companyData.subjectName,
            sanctionsMatches: sanctionsScreening.matches,
            adverseMedia,
            positiveMedia,
            associations: enrichedAssociations,
            riskAssessment: baselineRisks,
          });
        })
      : (setProviderStatus(id, "analysis", "done"),
        warnings.push("Executive summary and synthesis used fallback output because AI synthesis is not configured."),
        recordDebug(id, {
          scope: "analysis",
          level: "warning",
          message: "OpenAI is not configured, so the report used fallback synthesis.",
        }),
        buildSynthesisFallback({
          request,
          subjectName: companyData.subjectName,
          sanctionsMatches: sanctionsScreening.matches,
          adverseMedia,
          positiveMedia,
          associations: enrichedAssociations,
          riskAssessment: baselineRisks,
        }));
    const resolvedRiskAssessment = {
      ...synthesized.risk_assessment,
      insolvency: maxRiskLevel(
        synthesized.risk_assessment.insolvency,
        insolvencyData?.riskLevel || "green",
      ),
    };
    const overallRisk = deriveOverallRisk(resolvedRiskAssessment);
    const finalAssociations = dedupeAssociations([
      ...enrichedAssociations,
      ...synthesized.associations,
    ]);

    return {
      id,
      subject_name: companyData.subjectName,
      subject_type: request.subject_type,
      created_at: new Date().toISOString(),
      status: "complete",
      warnings,
      executive_summary: {
        ...synthesized.executive_summary,
        overall_risk: overallRisk,
        citations: buildExecutiveSummaryCitations({
          companySource: companyData.sources[0],
          sanctionsSource: (liveSanctions?.sources || seededSanctions.sources)[0],
          mediaSources,
        }),
      },
      corporate_profile: companyData.corporateProfile,
      officers: companyData.officers,
      pscs: companyData.pscs,
      sanctions_screening: sanctionsScreening,
      adverse_media: dedupeMedia([
        ...(insolvencyData?.findings || []),
        ...verifyMediaFindings(synthesized.adverse_media, adverseEvidence),
      ]),
      positive_media: verifyMediaFindings(synthesized.positive_media, positiveEvidence),
      associations: finalAssociations,
      risk_assessment: resolvedRiskAssessment,
      alternative_data_summary: liveMedia?.alternativeDataSummary,
      sources: dedupeSources([
        ...companyData.sources,
        ...(liveSanctions?.sources || seededSanctions.sources),
        ...(worldBankDebarments?.sources || []),
        ...mediaSources,
        ...(icijData?.sources || []),
        ...(gleifData?.sources || []),
        ...(fcaData?.sources || []),
      ]),
    };
  } catch {
    setProviderStatus(id, "companies_house", "error");
    const report = buildSeededReport(id, request);
    warnings.push("Corporate registry lookup failed, so company details fell back to seeded/demo data.");
    startStage(id, "analysis");
    const synthesized = hasOpenAiConfig()
      ? await runProvider(id, "analysis", () =>
          withTimeout(synthesizeReportWithOpenAi({
            request,
            subjectName: report.subject_name,
            corporateProfile: report.corporate_profile,
            subjectProfile: report.subject_profile,
            officers: report.officers,
            pscs: report.pscs,
            sanctionsMatches: sanctionsScreening.matches,
            adverseMedia,
            positiveMedia,
            adverseEvidence,
            positiveEvidence,
            associations: report.associations,
          }), 45000, "Catch-path synthesis")
        ).catch((error) => {
          setProviderStatus(id, "analysis", "done");
          warnings.push("Executive summary and synthesis used fallback output because AI synthesis failed.");
          recordDebug(id, {
            scope: "analysis",
            level: "warning",
            message: `Catch-path synthesis failed, so the report used fallback synthesis. Reason: ${getErrorMessage(error)}`,
          });
          return buildSynthesisFallback({
            request,
            subjectName: report.subject_name,
            sanctionsMatches: sanctionsScreening.matches,
            adverseMedia,
            positiveMedia,
            associations: dedupeAssociations([
              ...report.associations,
              ...(icijData?.associations || []),
              ...(gleifData?.associations || []),
            ]),
            riskAssessment: baselineRisks,
          });
        })
      : (setProviderStatus(id, "analysis", "done"),
        warnings.push("Executive summary and synthesis used fallback output because AI synthesis is not configured."),
        recordDebug(id, {
          scope: "analysis",
          level: "warning",
          message: "OpenAI is not configured, so the report used fallback synthesis.",
        }),
        buildSynthesisFallback({
          request,
          subjectName: report.subject_name,
          sanctionsMatches: sanctionsScreening.matches,
          adverseMedia,
          positiveMedia,
          associations: dedupeAssociations([
            ...report.associations,
            ...(icijData?.associations || []),
            ...(gleifData?.associations || []),
          ]),
          riskAssessment: baselineRisks,
        }));
    report.executive_summary = synthesized.executive_summary;
    report.executive_summary.citations = buildExecutiveSummaryCitations({
      sanctionsSource: (liveSanctions?.sources || seededSanctions.sources)[0],
      mediaSources,
    });
    report.risk_assessment = {
      ...synthesized.risk_assessment,
      insolvency: maxRiskLevel(
        synthesized.risk_assessment.insolvency,
        insolvencyData?.riskLevel || "green",
      ),
    };
    report.sanctions_screening = sanctionsScreening;
    report.adverse_media = dedupeMedia([
      ...(insolvencyData?.findings || []),
      ...verifyMediaFindings(synthesized.adverse_media, adverseEvidence),
    ]);
    report.positive_media = verifyMediaFindings(synthesized.positive_media, positiveEvidence);
    report.associations = dedupeAssociations([
      ...report.associations,
      ...(icijData?.associations || []),
      ...(gleifData?.associations || []),
      ...synthesized.associations,
    ]);
    report.warnings = warnings;
    report.alternative_data_summary = liveMedia?.alternativeDataSummary;
    report.sources = [
      ...report.sources.filter((source) => source.type !== "watchlist"),
      ...(liveSanctions?.sources || seededSanctions.sources),
      ...(worldBankDebarments?.sources || []),
      ...mediaSources,
      ...(icijData?.sources || []),
      ...(gleifData?.sources || []),
      ...(fcaData?.sources || []),
    ];
    report.sources = dedupeSources(report.sources);
    return report;
  }
}

export async function createReportJob(request: ReportRequest): Promise<ReportJob> {
  const id = randomUUID();
  const job: InternalJob = {
    id,
    createdAt: Date.now(),
    request,
    progress: createInitialProgress(),
    providerStatus: createInitialProviderStatus(),
    debugEvents: [],
  };
  jobs.set(id, job);
  persistJobs();

  buildReport(id, request)
    .then((report) => {
      const current = jobs.get(id);
      if (current) {
        current.report = enrichDerivedSections(report);
        markComplete(id);
        persistJobs();
      }
    })
    .catch((error) => {
      const current = jobs.get(id);
      if (current) {
        current.error = error instanceof Error ? error.message : "Report generation failed";
        recordDebug(id, {
          scope: "job",
          level: "error",
          message: `Report generation failed: ${current.error}`,
        });
        if (current.progress.analysis === "pending") {
          current.progress.analysis = "complete";
        }
        persistJobs();
      }
    });

  return {
    report_id: id,
    status: "processing",
    estimated_time_seconds: 45,
  };
}

export function getReportStatus(reportId: string): ReportStatusResponse | null {
  const job = jobs.get(reportId);

  if (!job) {
    return null;
  }

  const isComplete = Boolean(job.report);
  const hasError = Boolean(job.error);

  return {
    report_id: reportId,
    status: hasError ? "failed" : isComplete ? "complete" : "processing",
    progress: job.progress,
    provider_status: job.providerStatus,
    debug_events: job.debugEvents,
    report: isComplete ? job.report : undefined,
    error: job.error,
  };
}

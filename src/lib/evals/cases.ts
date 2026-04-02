import type { Report } from "../types";

export type EvalSuiteName = "request_extraction" | "media_triage" | "report_answer";

export interface RequestExtractionEvalCase {
  id: string;
  suite: "request_extraction";
  input: string;
  expected: {
    subject_name: string;
    subject_type: "individual" | "organisation";
    jurisdiction?: string;
    company_number?: string;
    date_of_birth?: string;
    emptySubject?: boolean;
  };
}

export interface MediaTriageEvalCase {
  id: string;
  suite: "media_triage";
  request: {
    subject_name: string;
    subject_type: "individual" | "organisation";
    jurisdiction?: string;
    additional_context?: string;
  };
  evidence: Array<{
    url: string;
    title: string;
    snippet: string;
    extracted_text: string;
    date: string;
  }>;
  expected: Record<string, "adverse" | "positive" | "ignore">;
}

export interface ReportAnswerEvalCase {
  id: string;
  suite: "report_answer";
  question: string;
  report: Report;
  expected: {
    mustInclude: string[];
    mustNotInclude?: string[];
    minCitations?: number;
  };
}

export type EvalCase =
  | RequestExtractionEvalCase
  | MediaTriageEvalCase
  | ReportAnswerEvalCase;

const sampleReport: Report = {
  id: "eval-report-1",
  subject_name: "Brian Kingham",
  subject_type: "individual",
  created_at: "2026-04-02T10:00:00.000Z",
  status: "complete",
  executive_summary: {
    text: "The report identifies limited but notable reputational sensitivity from public-source coverage and no confirmed sanctions match.",
    overall_risk: "amber",
    citations: [
      { url: "https://example.com/article-1", title: "Article 1" },
      { url: "https://example.com/opensanctions", title: "OpenSanctions" },
    ],
  },
  subject_profile: {
    headline: "UK business figure",
    known_for: ["property", "investment"],
    locations: ["United Kingdom"],
  },
  officers: [],
  pscs: [],
  sanctions_screening: {
    matches: [
      {
        entity_name: "Brian Kingham",
        dataset: "OpenSanctions",
        score: 0.08,
        status: "clear",
        detail: "No meaningful match identified.",
      },
    ],
    lists_checked: 1487,
    status: "clear",
  },
  adverse_media: [
    {
      summary: "Coverage discussed local criticism of a planning proposal linked to the subject's estate.",
      risk_category: "reputational",
      severity: "medium",
      source_url: "https://example.com/article-1",
      source_title: "Local planning dispute coverage",
      date: "2020-07-07",
      verification_status: "verified",
    },
  ],
  positive_media: [],
  associations: [],
  risk_assessment: {
    financial_crime: "green",
    regulatory: "green",
    esg: "green",
    reputational: "amber",
    sanctions: "green",
    insolvency: "green",
  },
  sources: [
    {
      url: "https://example.com/article-1",
      title: "Local planning dispute coverage",
      type: "news",
      accessed_at: "2026-04-02T10:00:00.000Z",
    },
    {
      url: "https://example.com/opensanctions",
      title: "OpenSanctions",
      type: "watchlist",
      accessed_at: "2026-04-02T10:00:00.000Z",
    },
  ],
};

export const EVAL_CASES: EvalCase[] = [
  {
    id: "request-org-basic",
    suite: "request_extraction",
    input: "Screen Acme Holdings Ltd in the UK, company number 12345678.",
    expected: {
      subject_name: "Acme Holdings Ltd",
      subject_type: "organisation",
      jurisdiction: "gb",
      company_number: "12345678",
    },
  },
  {
    id: "request-individual-basic",
    suite: "request_extraction",
    input: "Check Jane Doe born 1980 with UAE links.",
    expected: {
      subject_name: "Jane Doe",
      subject_type: "individual",
      jurisdiction: "ae",
      date_of_birth: "1980",
    },
  },
  {
    id: "request-follow-up-no-subject",
    suite: "request_extraction",
    input: "What are the main risk drivers?",
    expected: {
      subject_name: "",
      subject_type: "individual",
      emptySubject: true,
    },
  },
  {
    id: "media-ignore-speaker-bio",
    suite: "media_triage",
    request: {
      subject_name: "Peter Mandelson",
      subject_type: "individual",
      jurisdiction: "gb",
    },
    evidence: [
      {
        url: "https://milkeninstitute.org/events/asia-summit/speakers/lord-mandelson",
        title: "Lord Mandelson | Milken Institute",
        snippet: "Peter Mandelson is co-founder and chairman of Global Counsel.",
        extracted_text:
          "Peter Mandelson is co-founder and chairman of Global Counsel. Asia Summit speaker profile.",
        date: "2019-09-18",
      },
      {
        url: "https://example.com/news-1",
        title: "Former minister faces criticism over planning dispute",
        snippet: "Neighbours objected to the proposal linked to the estate.",
        extracted_text:
          "Neighbours objected to the proposal linked to the estate. The article reports criticism and a planning dispute.",
        date: "2020-07-07",
      },
    ],
    expected: {
      "https://milkeninstitute.org/events/asia-summit/speakers/lord-mandelson": "ignore",
      "https://example.com/news-1": "adverse",
    },
  },
  {
    id: "answer-risk-driver",
    suite: "report_answer",
    question: "What are the main risk drivers?",
    report: sampleReport,
    expected: {
      mustInclude: ["amber", "planning", "reputational"],
      mustNotInclude: ["confirmed sanctions exposure"],
      minCitations: 1,
    },
  },
];

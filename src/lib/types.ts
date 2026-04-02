export type SubjectType = "individual" | "organisation";
export type ReportStatus = "processing" | "complete" | "failed";
export type RiskLevel = "green" | "amber" | "red";
export type MatchConfidence = "weak" | "moderate" | "strong";
export type ProgressState = "pending" | "in_progress" | "complete";
export type ProviderRunStatus = "pending" | "running" | "done" | "error";

export interface DebugEvent {
  at: string;
  scope: string;
  level: "info" | "warning" | "error";
  message: string;
}

export interface ReportRequest {
  subject_name: string;
  subject_type: SubjectType;
  jurisdiction?: string;
  company_number?: string;
  date_of_birth?: string;
  additional_context?: string;
}

export interface Officer {
  name: string;
  role: string;
  appointed_on: string;
  resigned_on?: string;
}

export interface PSC {
  name: string;
  kind: string;
  notified_on: string;
  ownership?: string;
}

export interface SanctionsMatch {
  entity_name: string;
  dataset: string;
  score: number;
  status: "clear" | "potential_match" | "confirmed_match";
  detail: string;
  office_summary?: string;
  match_reason?: string;
  match_confidence?: MatchConfidence;
}

export interface MediaFinding {
  summary: string;
  risk_category: string;
  severity: "low" | "medium" | "high";
  source_url: string;
  source_title: string;
  date: string;
  verification_status?: "verified" | "fallback" | "weak";
  evidence_spans?: string[];
  match_reason?: string;
  match_confidence?: MatchConfidence;
}

export interface Association {
  subject: string;
  relationship: string;
  detail: string;
  source_url: string;
  match_reason?: string;
  match_confidence?: MatchConfidence;
}

export interface Source {
  url: string;
  title: string;
  type: "corporate_registry" | "news" | "watchlist" | "web" | "regulatory" | "background" | "alternative";
  accessed_at: string;
}

export interface Citation {
  url: string;
  title: string;
}

export interface RiskAssessment {
  financial_crime: RiskLevel;
  regulatory: RiskLevel;
  esg: RiskLevel;
  reputational: RiskLevel;
  sanctions: RiskLevel;
  insolvency: RiskLevel;
}

export interface ExecutiveSummary {
  text: string;
  overall_risk: RiskLevel;
  citations?: Citation[];
}

export interface CorporateProfile {
  company_number: string;
  status: string;
  type: string;
  sic_codes: string[];
  registered_address: string;
  incorporated: string;
  accounts_due: string;
}

export interface SubjectProfile {
  headline: string;
  known_for: string[];
  locations: string[];
}

export interface RiskDriver {
  title: string;
  detail: string;
  severity: "low" | "medium" | "high";
}

export interface CurrentStatus {
  summary: string;
  source_labels: string[];
}

export interface Contradiction {
  topic: string;
  detail: string;
}

export interface AlternativeDataSummary {
  text: string;
  citations: Citation[];
}

export interface Report {
  id: string;
  subject_name: string;
  subject_type: SubjectType;
  created_at: string;
  status: ReportStatus;
  warnings?: string[];
  executive_summary: ExecutiveSummary;
  corporate_profile?: CorporateProfile;
  subject_profile?: SubjectProfile;
  officers: Officer[];
  pscs: PSC[];
  sanctions_screening: {
    matches: SanctionsMatch[];
    lists_checked: number;
    status: "clear" | "potential_match" | "confirmed_match";
  };
  adverse_media: MediaFinding[];
  positive_media: MediaFinding[];
  associations: Association[];
  risk_assessment: RiskAssessment;
  sources: Source[];
  risk_drivers?: RiskDriver[];
  current_status?: CurrentStatus;
  contradictions?: Contradiction[];
  changes_since_last_run?: string[];
  alternative_data_summary?: AlternativeDataSummary;
}

export interface ReportProgress {
  corporate_records: ProgressState;
  web_search: ProgressState;
  sanctions_screening: ProgressState;
  analysis: ProgressState;
}

export interface ReportJob {
  report_id: string;
  status: ReportStatus;
  estimated_time_seconds: number;
}

export interface ReportStatusResponse {
  report_id: string;
  status: ReportStatus;
  progress: ReportProgress;
  provider_status?: Record<string, ProviderRunStatus>;
  debug_events?: DebugEvent[];
  report?: Report;
  error?: string;
}

export type AgentAction =
  | "create_report"
  | "report_status"
  | "answer_report"
  | "clarify";

export interface AgentRequest {
  message: string;
  report_id?: string;
}

export interface AgentResponse {
  action: AgentAction;
  message: string;
  report_request?: ReportRequest;
  report_job?: ReportJob;
  report_status?: ReportStatusResponse;
  citations?: Citation[];
  resolved_subject_name?: string;
  resolution_confidence?: MatchConfidence;
  confirmation_required?: boolean;
}

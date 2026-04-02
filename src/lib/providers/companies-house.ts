import { env } from "@/lib/env";
import type {
  Association,
  CorporateProfile,
  MatchConfidence,
  Officer,
  PSC,
  ReportRequest,
  Source,
  SubjectProfile,
} from "@/lib/types";

const BASE_URL = "https://api.company-information.service.gov.uk";
const PUBLIC_RECORDS_URL = "https://find-and-update.company-information.service.gov.uk";

interface CompaniesHouseSearchItem {
  company_name?: string;
  company_number?: string;
  company_status?: string;
  address_snippet?: string;
}

interface CompaniesHouseSearchResponse {
  items?: CompaniesHouseSearchItem[];
}

interface CompaniesHouseOfficerSearchItem {
  title?: string;
  appointment_count?: number;
  date_of_birth?: {
    month?: number;
    year?: number;
  };
  links?: {
    self?: string;
  };
  address_snippet?: string;
}

interface CompaniesHouseOfficerSearchResponse {
  items?: CompaniesHouseOfficerSearchItem[];
}

interface CompaniesHouseCompanyProfileResponse {
  company_name?: string;
  company_number?: string;
  company_status?: string;
  type?: string;
  sic_codes?: string[];
  date_of_creation?: string;
  registered_office_address?: {
    address_line_1?: string;
    address_line_2?: string;
    locality?: string;
    region?: string;
    postal_code?: string;
    country?: string;
  };
  accounts?: {
    next_accounts?: {
      due_on?: string;
    };
  };
}

interface CompaniesHouseOfficerItem {
  name?: string;
  appointed_on?: string;
  resigned_on?: string;
  officer_role?: string;
}

interface CompaniesHouseOfficersResponse {
  items?: CompaniesHouseOfficerItem[];
}

interface CompaniesHousePscItem {
  name?: string;
  notified_on?: string;
  kind?: string;
  natures_of_control?: string[];
}

interface CompaniesHousePscResponse {
  items?: CompaniesHousePscItem[];
}

interface CompaniesHouseAppointmentItem {
  appointed_on?: string;
  resigned_on?: string;
  officer_role?: string;
  appointed_to?: {
    company_name?: string;
    company_number?: string;
    company_status?: string;
  };
}

interface CompaniesHouseAppointmentsResponse {
  items?: CompaniesHouseAppointmentItem[];
}

interface RankedOfficerCandidate {
  item: CompaniesHouseOfficerSearchItem;
  score: number;
}

export interface CompaniesHouseOrganisationData {
  subjectName: string;
  corporateProfile: CorporateProfile;
  officers: Officer[];
  pscs: PSC[];
  sources: Source[];
}

export interface CompaniesHouseIndividualData {
  subjectName: string;
  subjectProfile: SubjectProfile;
  officers: Officer[];
  associations: Association[];
  sources: Source[];
  matchReason: string;
  matchConfidence: MatchConfidence;
  warnings?: string[];
}

function getAuthHeader() {
  const key = env.companiesHouseApiKey;
  if (!key) {
    throw new Error("COMPANIES_HOUSE_API_KEY is not configured.");
  }

  return `Basic ${Buffer.from(`${key}:`).toString("base64")}`;
}

async function companiesHouseFetch<T>(path: string) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Authorization: getAuthHeader(),
    },
    cache: "no-store",
    signal: AbortSignal.timeout(18000),
  });

  if (!response.ok) {
    throw new Error(`Companies House request failed (${response.status}) for ${path}`);
  }

  return (await response.json()) as T;
}

function formatAddress(address: CompaniesHouseCompanyProfileResponse["registered_office_address"]) {
  if (!address) {
    return "Address not available";
  }

  return [
    address.address_line_1,
    address.address_line_2,
    address.locality,
    address.region,
    address.postal_code,
    address.country,
  ]
    .filter(Boolean)
    .join(", ");
}

function normaliseControlLabel(values: string[] | undefined) {
  if (!values?.length) {
    return undefined;
  }

  return values
    .map((value) => value.replace(/-/g, " "))
    .join(", ");
}

function normaliseName(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokeniseName(value: string) {
  return normaliseName(value)
    .split(" ")
    .filter(Boolean);
}

function parsePartialDateHint(value?: string) {
  if (!value) {
    return {};
  }

  const trimmed = value.trim();
  const fullDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (fullDateMatch) {
    return {
      year: Number(fullDateMatch[1]),
      month: Number(fullDateMatch[2]),
      day: Number(fullDateMatch[3]),
    };
  }

  const yearMonthMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (yearMonthMatch) {
    return {
      year: Number(yearMonthMatch[1]),
      month: Number(yearMonthMatch[2]),
    };
  }

  const yearOnlyMatch = /^(\d{4})$/.exec(trimmed);
  if (yearOnlyMatch) {
    return {
      year: Number(yearOnlyMatch[1]),
    };
  }

  return {};
}

export function samePersonCandidate(
  candidate: CompaniesHouseOfficerSearchItem,
  anchor: CompaniesHouseOfficerSearchItem,
  request: ReportRequest,
) {
  const candidateName = normaliseName(candidate.title || "");
  const anchorName = normaliseName(anchor.title || "");

  if (!candidate.links?.self || !candidateName || candidateName !== anchorName) {
    return false;
  }

  const requestedDate = parsePartialDateHint(request.date_of_birth);
  const candidateDob = candidate.date_of_birth || {};
  const anchorDob = anchor.date_of_birth || {};

  if (requestedDate.year) {
    if (candidateDob.year !== requestedDate.year) {
      return false;
    }
    if (requestedDate.month && candidateDob.month && candidateDob.month !== requestedDate.month) {
      return false;
    }
  }

  if (candidateDob.year && anchorDob.year && candidateDob.year !== anchorDob.year) {
    return false;
  }

  if (candidateDob.month && anchorDob.month && candidateDob.month !== anchorDob.month) {
    return false;
  }

  return true;
}

function dedupeAppointments(items: CompaniesHouseAppointmentItem[]) {
  return items.filter((item, index, all) => {
    const key = [
      item.officer_role || "",
      item.appointed_on || "",
      item.resigned_on || "",
      item.appointed_to?.company_name || "",
      item.appointed_to?.company_number || "",
    ].join("|");

    return (
      all.findIndex((entry) => {
        const entryKey = [
          entry.officer_role || "",
          entry.appointed_on || "",
          entry.resigned_on || "",
          entry.appointed_to?.company_name || "",
          entry.appointed_to?.company_number || "",
        ].join("|");
        return entryKey === key;
      }) === index
    );
  });
}

async function loadMergedAppointments(
  candidates: RankedOfficerCandidate[],
  request: ReportRequest,
) {
  const bestEntry = candidates[0];
  const bestMatch = bestEntry?.item;

  if (!bestEntry || !bestMatch?.links?.self) {
    return {
      mergedAppointments: [] as CompaniesHouseAppointmentItem[],
      mergedCandidates: [] as RankedOfficerCandidate[],
    };
  }

  const mergeableCandidates = candidates
    .filter(
      (candidate) =>
        candidate.score >= Math.max(10, bestEntry.score - 2) &&
        samePersonCandidate(candidate.item, bestMatch, request),
    )
    .slice(0, 3);

  const appointmentResponses = await Promise.all(
    mergeableCandidates.map(async (candidate) => ({
      candidate,
      appointments: await companiesHouseFetch<CompaniesHouseAppointmentsResponse>(
        candidate.item.links?.self || "",
      ),
    })),
  );

  return {
    mergedAppointments: dedupeAppointments(
      appointmentResponses.flatMap((entry) => entry.appointments.items || []),
    ),
    mergedCandidates: appointmentResponses.map((entry) => entry.candidate),
  };
}

function buildCompanySource(companyNumber: string, title: string): Source {
  return {
    url: `${PUBLIC_RECORDS_URL}/company/${companyNumber}`,
    title,
    type: "corporate_registry",
    accessed_at: new Date().toISOString(),
  };
}

async function resolveCompanyNumber(request: ReportRequest) {
  if (request.company_number?.trim()) {
    return request.company_number.trim();
  }

  const search = await companiesHouseFetch<CompaniesHouseSearchResponse>(
    `/search/companies?q=${encodeURIComponent(request.subject_name)}`,
  );

  const top = search.items?.find((item) => item.company_number)?.company_number;
  if (!top) {
    throw new Error(`No Companies House match found for "${request.subject_name}".`);
  }

  return top;
}

export async function fetchOrganisationFromCompaniesHouse(
  request: ReportRequest,
): Promise<CompaniesHouseOrganisationData> {
  const companyNumber = await resolveCompanyNumber(request);

  const [profile, officersResponse, pscResponse] = await Promise.all([
    companiesHouseFetch<CompaniesHouseCompanyProfileResponse>(`/company/${companyNumber}`),
    companiesHouseFetch<CompaniesHouseOfficersResponse>(`/company/${companyNumber}/officers`),
    companiesHouseFetch<CompaniesHousePscResponse>(
      `/company/${companyNumber}/persons-with-significant-control`,
    ).catch(() => ({ items: [] })),
  ]);

  const subjectName = profile.company_name || request.subject_name;

  return {
    subjectName,
    corporateProfile: {
      company_number: profile.company_number || companyNumber,
      status: profile.company_status || "Unknown",
      type: profile.type || "Unknown",
      sic_codes: profile.sic_codes || [],
      registered_address: formatAddress(profile.registered_office_address),
      incorporated: profile.date_of_creation || "Unknown",
      accounts_due: profile.accounts?.next_accounts?.due_on || "Unknown",
    },
    officers:
      officersResponse.items?.map((item) => ({
        name: item.name || "Unknown",
        role: item.officer_role || "Officer",
        appointed_on: item.appointed_on || "Unknown",
        resigned_on: item.resigned_on,
      })) || [],
    pscs:
      pscResponse.items?.map((item) => ({
        name: item.name || "Unknown",
        kind: item.kind || "PSC",
        notified_on: item.notified_on || "Unknown",
        ownership: normaliseControlLabel(item.natures_of_control),
      })) || [],
    sources: [
      buildCompanySource(
        companyNumber,
        `Companies House record for ${subjectName}`,
      ),
    ],
  };
}

export function scoreOfficerCandidate(item: CompaniesHouseOfficerSearchItem, request: ReportRequest) {
  let score = 0;
  const title = item.title || "";
  const normalizedTitle = normaliseName(title);
  const normalizedName = normaliseName(request.subject_name);
  const titleTokens = tokeniseName(title);
  const nameTokens = tokeniseName(request.subject_name);

  if (normalizedTitle === normalizedName) {
    score += 6;
  }

  if (nameTokens.length > 0 && nameTokens.every((token) => titleTokens.includes(token))) {
    score += 8;
  }

  if (titleTokens[0] && titleTokens[0] === nameTokens[0]) {
    score += 3;
  }

  if (
    titleTokens.length > 1 &&
    nameTokens.length > 1 &&
    titleTokens[titleTokens.length - 1] === nameTokens[nameTokens.length - 1]
  ) {
    score += 4;
  }

  if (normalizedTitle.includes(normalizedName) && titleTokens.length === nameTokens.length) {
    score += 2;
  }

  if (titleTokens.length > nameTokens.length && nameTokens.length >= 2) {
    score += 2;
  }

  if (request.date_of_birth) {
    const { year, month } = parsePartialDateHint(request.date_of_birth);
    if (item.date_of_birth?.year === year) {
      score += 3;
    }
    if (month && item.date_of_birth?.month === month) {
      score += 1;
    }
  }

  if (typeof item.appointment_count === "number") {
    score += Math.min(item.appointment_count, 40) * 0.45;
  }

  if (!item.date_of_birth) {
    score -= 4;
  }

  if (
    request.additional_context &&
    item.address_snippet?.toLowerCase().includes(request.additional_context.toLowerCase())
  ) {
    score += 2;
  }

  return score;
}

export function determineConfidence(score: number): MatchConfidence {
  if (score >= 22) {
    return "strong";
  }

  if (score >= 14) {
    return "moderate";
  }

  return "weak";
}

export function downgradeConfidence(confidence: MatchConfidence): MatchConfidence {
  if (confidence === "strong") {
    return "moderate";
  }

  return "weak";
}

function buildOfficerMatchReason(item: CompaniesHouseOfficerSearchItem, request: ReportRequest) {
  const reasons: string[] = [];
  const title = item.title || "";
  const normalizedTitle = normaliseName(title);
  const normalizedName = normaliseName(request.subject_name);
  const titleTokens = tokeniseName(title);
  const nameTokens = tokeniseName(request.subject_name);

  if (normalizedTitle === normalizedName) {
    reasons.push("exact full-name match");
  } else if (nameTokens.length > 0 && nameTokens.every((token) => titleTokens.includes(token))) {
    reasons.push("all name tokens matched");
  } else if (titleTokens[0] && nameTokens[0] && titleTokens[0] === nameTokens[0]) {
    reasons.push("first-name alignment");
  }

  if (
    titleTokens.length > 1 &&
    nameTokens.length > 1 &&
    titleTokens[titleTokens.length - 1] === nameTokens[nameTokens.length - 1]
  ) {
    reasons.push("surname alignment");
  }

  if (request.date_of_birth) {
    const { year, month } = parsePartialDateHint(request.date_of_birth);
    if (item.date_of_birth?.year === year) {
      reasons.push("date-of-birth year matched");
    }
    if (month && item.date_of_birth?.month === month) {
      reasons.push("date-of-birth month matched");
    }
  }

  if (typeof item.appointment_count === "number" && item.appointment_count > 0) {
    reasons.push(`appointment history count ${item.appointment_count}`);
  }

  if (
    request.additional_context &&
    item.address_snippet?.toLowerCase().includes(request.additional_context.toLowerCase())
  ) {
    reasons.push("address/context overlap");
  }

  return reasons.length ? reasons.join("; ") : "name-only Companies House officer search match";
}

export async function fetchIndividualFromCompaniesHouse(
  request: ReportRequest,
): Promise<CompaniesHouseIndividualData> {
  const search = await companiesHouseFetch<CompaniesHouseOfficerSearchResponse>(
    `/search/officers?q=${encodeURIComponent(request.subject_name)}`,
  );

  const rankedMatches: RankedOfficerCandidate[] = (search.items || [])
    .map((item) => ({ item, score: scoreOfficerCandidate(item, request) }))
    .sort((left, right) => right.score - left.score);
  const bestEntry = rankedMatches[0];
  const secondEntry = rankedMatches[1];
  const bestMatch = bestEntry?.item;

  if (!bestMatch?.links?.self || !bestEntry || bestEntry.score < 10) {
    throw new Error(`No officer match found for "${request.subject_name}".`);
  }

  const { mergedAppointments, mergedCandidates } = await loadMergedAppointments(
    rankedMatches,
    request,
  );

  const subjectName = bestMatch.title || request.subject_name;
  const appointmentItems = mergedAppointments;
  const matchReason = buildOfficerMatchReason(bestMatch, request);
  const ambiguousWithoutDob =
    Boolean(secondEntry) && bestEntry.score - secondEntry.score < 2 && !request.date_of_birth;
  const warnings = [
    ...(ambiguousWithoutDob
      ? [
          "Companies House officer match is ambiguous because multiple close name matches were returned without date of birth input.",
        ]
      : []),
    ...(mergedCandidates.length > 1
      ? [
          `Multiple compatible Companies House officer records were consolidated for ${subjectName}.`,
        ]
      : []),
  ];
  const matchConfidence = ambiguousWithoutDob
    ? downgradeConfidence(determineConfidence(bestEntry.score))
    : determineConfidence(bestEntry.score);

  const officers = appointmentItems.slice(0, 8).map((item) => ({
    name: subjectName,
    role: `${item.officer_role || "officer"}, ${item.appointed_to?.company_name || "Unknown company"}`,
    appointed_on: item.appointed_on || "Unknown",
    resigned_on: item.resigned_on,
  }));

  const associations = appointmentItems.slice(0, 6).map((item) => ({
    subject: item.appointed_to?.company_name || "Unknown company",
    relationship: item.officer_role === "director" ? "Directorship" : "Appointment",
    detail:
      item.appointed_to?.company_status
        ? `Companies House appointment record with status ${item.appointed_to.company_status}.`
        : "Companies House appointment record.",
    source_url: "https://find-and-update.company-information.service.gov.uk/",
    match_reason: matchReason,
    match_confidence: matchConfidence,
  }));

  const locations = bestMatch.address_snippet ? [bestMatch.address_snippet] : [request.jurisdiction?.toUpperCase() || "UK"];
  const knownFor = associations.slice(0, 3).map((item) => item.relationship);

  return {
    subjectName,
    subjectProfile: {
      headline: `${subjectName} appears in Companies House officer records with current or historic UK appointments. Match basis: ${matchReason}.`,
      known_for: knownFor.length ? knownFor : ["Companies House appointments"],
      locations,
    },
    officers,
    associations,
    sources: [
      {
        url: "https://find-and-update.company-information.service.gov.uk/",
        title: `Companies House officer search for ${subjectName}`,
        type: "corporate_registry",
        accessed_at: new Date().toISOString(),
      },
    ],
    matchReason,
    matchConfidence,
    warnings,
  };
}

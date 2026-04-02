import type { ReportRequest, RiskLevel, SanctionsMatch, Source } from "@/lib/types";

const PAGE_URL =
  "https://projects.worldbank.org/en/projects-operations/procurement/debarred-firms";
const API_URL =
  "https://apigwext.worldbank.org/dvsvc/v1.0/json/APPLICATION/ADOBE_EXPRNCE_MGR/FIRM/SANCTIONED_FIRM";
const EMBEDDED_API_KEY = "z9duUaFUiEUYSHs97CU38fcZO7ipOPvm";

interface DebarredFirmRecord {
  firm_name?: string;
  address?: string;
  country?: string;
  from_date?: string;
  to_date?: string;
  grounds?: string;
  SUPP_NAME?: string;
  SUPP_ADDR?: string;
  COUNTRY_NAME?: string;
  DEBAR_FROM_DATE?: string;
  DEBAR_TO_DATE?: string;
  DEBAR_REASON?: string;
}

interface WorldBankDebarmentsPayload {
  response?: {
    ZPROCSUPP?: DebarredFirmRecord[];
  };
}

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(value: string) {
  return normalise(value).split(" ").filter(Boolean);
}

export function scoreWorldBankDebarmentRecord(record: DebarredFirmRecord, request: ReportRequest) {
  const subjectTokens = tokenise(request.subject_name);
  const firmName = record.firm_name || record.SUPP_NAME || "";
  const recordTokens = tokenise(firmName);
  let score = 0;

  if (normalise(firmName) === normalise(request.subject_name)) {
    score += 1;
  }

  if (subjectTokens.length && subjectTokens.every((token) => recordTokens.includes(token))) {
    score += 0.85;
  }

  if (
    request.jurisdiction &&
    normalise(record.country || record.COUNTRY_NAME || "").includes(normalise(request.jurisdiction))
  ) {
    score += 0.08;
  }

  if (
    request.additional_context &&
    normalise(
      `${record.address || record.SUPP_ADDR || ""} ${record.grounds || record.DEBAR_REASON || ""}`,
    ).includes(
      normalise(request.additional_context),
    )
  ) {
    score += 0.06;
  }

  return Math.min(score, 1);
}

function riskForMatch(score: number): RiskLevel {
  return score >= 0.95 ? "red" : "amber";
}

export async function researchWithWorldBankDebarments(request: ReportRequest): Promise<{
  matches: SanctionsMatch[];
  sources: Source[];
  riskLevel: RiskLevel;
}> {
  const response = await fetch(API_URL, {
    headers: {
      apikey: EMBEDDED_API_KEY,
      "User-Agent": "OpenDiligenceBot/0.1 (+prototype due diligence research)",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(12000),
  });

  if (!response.ok) {
    throw new Error(`World Bank Debarments request failed (${response.status})`);
  }

  const payload = (await response.json()) as WorldBankDebarmentsPayload | DebarredFirmRecord[];
  const records = Array.isArray(payload)
    ? payload
    : Array.isArray(payload.response?.ZPROCSUPP)
      ? payload.response.ZPROCSUPP
      : [];

  if (!records.length) {
    throw new Error("World Bank Debarments returned no usable records.");
  }

  const ranked = records
    .map((record) => ({ record, score: scoreWorldBankDebarmentRecord(record, request) }))
    .filter((entry) => entry.score >= 0.85)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3);

  if (!ranked.length) {
    return {
      matches: [],
      sources: [],
      riskLevel: "green",
    };
  }

  const now = new Date().toISOString();
  const matches = ranked.map(({ record, score }) => ({
    entity_name: record.firm_name || record.SUPP_NAME || request.subject_name,
    dataset: "World Bank Debarments",
    score,
    status: score >= 0.95 ? ("confirmed_match" as const) : ("potential_match" as const),
    detail: [
      "World Bank debarment listing match.",
      record.country || record.COUNTRY_NAME
        ? `Country: ${record.country || record.COUNTRY_NAME}.`
        : "",
      record.grounds || record.DEBAR_REASON
        ? `Grounds: ${record.grounds || record.DEBAR_REASON}.`
        : "",
      record.from_date || record.to_date || record.DEBAR_FROM_DATE || record.DEBAR_TO_DATE
        ? `Period: ${record.from_date || record.DEBAR_FROM_DATE || "unknown"} to ${record.to_date || record.DEBAR_TO_DATE || "open"}`
        : "",
    ]
      .filter(Boolean)
      .join(" "),
  }));

  return {
    matches,
    sources: ranked.map(({ record }) => ({
      url: PAGE_URL,
      title: `World Bank Debarments listing for ${record.firm_name || record.SUPP_NAME || request.subject_name}`,
      type: "watchlist",
      accessed_at: now,
    })),
    riskLevel: ranked.reduce<RiskLevel>(
      (current, entry) => (riskForMatch(entry.score) === "red" ? "red" : current),
      "amber",
    ),
  };
}

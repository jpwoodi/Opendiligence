import type {
  Association,
  MatchConfidence,
  MediaFinding,
  ReportRequest,
  Source,
} from "@/lib/types";

const BASE_URL = "https://offshoreleaks.icij.org";
const RECONCILE_URL = `${BASE_URL}/api/v1/reconcile`;

interface ICIJType {
  id?: string;
  name?: string;
}

interface ICIJResult {
  id?: string;
  name?: string;
  description?: string;
  score?: number;
  types?: ICIJType[];
}

interface ICIJResponse {
  result?: ICIJResult[];
}

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(value: string) {
  return normalise(value).split(" ").filter(Boolean);
}

function scoreResult(result: ICIJResult, request: ReportRequest) {
  const queryTokens = tokenise(request.subject_name);
  const nameTokens = tokenise(result.name || "");
  let score = typeof result.score === "number" ? result.score : 0;

  if (queryTokens.length && queryTokens.every((token) => nameTokens.includes(token))) {
    score += 25;
  }

  if (normalise(result.name || "") === normalise(request.subject_name)) {
    score += 40;
  }

  if (
    request.jurisdiction &&
    `${result.description || ""} ${result.name || ""}`
      .toLowerCase()
      .includes(request.jurisdiction.toLowerCase())
  ) {
    score += 8;
  }

  return score;
}

function determineConfidence(score: number): MatchConfidence {
  if (score >= 90) {
    return "strong";
  }

  if (score >= 55) {
    return "moderate";
  }

  return "weak";
}

function buildMatchReason(result: ICIJResult, request: ReportRequest) {
  const reasons: string[] = [];
  const queryTokens = tokenise(request.subject_name);
  const nameTokens = tokenise(result.name || "");

  if (normalise(result.name || "") === normalise(request.subject_name)) {
    reasons.push("exact full-name match");
  } else if (queryTokens.length && queryTokens.every((token) => nameTokens.includes(token))) {
    reasons.push("all name tokens matched");
  }

  if (request.jurisdiction && `${result.description || ""} ${result.name || ""}`.toLowerCase().includes(request.jurisdiction.toLowerCase())) {
    reasons.push("jurisdiction/context overlap");
  }

  if (result.types?.length) {
    reasons.push(`record typed as ${result.types.map((type) => type.name).filter(Boolean).join(", ")}`);
  }

  return reasons.length ? reasons.join("; ") : "ICIJ reconciliation match";
}

async function reconcile(query: string, type: "Entity" | "Intermediary" | "Officer") {
  const response = await fetch(RECONCILE_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
    body: JSON.stringify({
      query,
      type,
    }),
  });

  if (!response.ok) {
    throw new Error(`ICIJ reconcile request failed (${response.status}) for type ${type}`);
  }

  return (await response.json()) as ICIJResponse;
}

function buildNodeUrl(id: string) {
  return `${BASE_URL}/nodes/${id}`;
}

function toAssociation(result: ICIJResult, request: ReportRequest, score: number): Association {
  const nodeUrl = result.id ? buildNodeUrl(result.id) : `${BASE_URL}/investigations/offshore-leaks`;
  const typeLabel = result.types?.map((type) => type.name).filter(Boolean).join(", ") || "record";
  const detail = [
    `Potential ICIJ Offshore Leaks match surfaced as ${typeLabel}.`,
    result.description || "The entry appears in the leaked-data index.",
    "Inclusion is a risk signal and not proof of wrongdoing; identity should be confirmed against address and context.",
  ].join(" ");

  return {
    subject: result.name || "ICIJ Offshore Leaks match",
    relationship: "Offshore leaks record",
    detail,
    source_url: nodeUrl,
    match_reason: buildMatchReason(result, request),
    match_confidence: determineConfidence(score),
  };
}

function toAdverseFinding(result: ICIJResult, request: ReportRequest, score: number): MediaFinding {
  const nodeUrl = result.id ? buildNodeUrl(result.id) : `${BASE_URL}/investigations/offshore-leaks`;

  return {
    summary: [
      `${result.name || "Subject"} appears in the ICIJ Offshore Leaks Database.`,
      result.description || "The record is linked to leaked offshore or secrecy-jurisdiction data.",
      "This should be treated as a diligence lead rather than proof of misconduct.",
    ].join(" "),
    risk_category: "offshore_leaks",
    severity: "medium",
    source_url: nodeUrl,
    source_title: "ICIJ Offshore Leaks Database",
    date: new Date().toISOString().slice(0, 10),
    match_reason: buildMatchReason(result, request),
    match_confidence: determineConfidence(score),
  };
}

export async function researchWithIcij(request: ReportRequest): Promise<{
  associations: Association[];
  adverseMedia: MediaFinding[];
  sources: Source[];
}> {
  const searchTypes =
    request.subject_type === "organisation"
      ? (["Entity", "Intermediary"] as const)
      : (["Officer"] as const);

  const responses = await Promise.all(searchTypes.map((type) => reconcile(request.subject_name, type)));
  const candidates = responses
    .flatMap((response) => response.result || [])
    .filter((result) => result.id && result.name)
    .map((result) => ({ result, score: scoreResult(result, request) }))
    .filter(({ result, score }) => {
      if (request.subject_type !== "individual") {
        return true;
      }

      const queryTokens = tokenise(request.subject_name);
      const nameTokens = tokenise(result.name || "");
      const allNameTokensMatch =
        queryTokens.length > 0 && queryTokens.every((token) => nameTokens.includes(token));

      return score >= 45 && allNameTokensMatch;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry);

  const associations = candidates.map(({ result, score }) => toAssociation(result, request, score));
  const adverseMedia = candidates.slice(0, 2).map(({ result, score }) => toAdverseFinding(result, request, score));
  const now = new Date().toISOString();
  const sources = candidates.map(({ result }) => ({
    url: buildNodeUrl(result.id as string),
    title: `ICIJ Offshore Leaks entry for ${result.name}`,
    type: "watchlist" as const,
    accessed_at: now,
  }));

  return {
    associations,
    adverseMedia,
    sources,
  };
}

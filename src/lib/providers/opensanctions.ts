import { env } from "@/lib/env";
import type {
  MatchConfidence,
  ReportRequest,
  SanctionsMatch,
  Source,
  SubjectType,
} from "@/lib/types";

const BASE_URL = "https://api.opensanctions.org";

type DynamicRecord = Record<string, unknown>;

interface OpenSanctionsResult {
  score?: number;
  match?: boolean;
  caption?: string;
  schema?: string;
  datasets?: string[];
  explanations?: Record<string, unknown> | Array<Record<string, unknown>>;
  properties?: {
    name?: string[];
    alias?: string[];
    position?: string[];
    country?: string[];
    birthDate?: string[];
    notes?: string[];
    sourceUrl?: string[];
  };
  entity?: {
    caption?: string;
    schema?: string;
    datasets?: string[];
    properties?: {
      name?: string[];
      alias?: string[];
      position?: string[];
      country?: string[];
      birthDate?: string[];
      notes?: string[];
      sourceUrl?: string[];
    };
  };
}

function getAuthHeader() {
  const key = env.openSanctionsApiKey;
  if (!key) {
    throw new Error("OPENSANCTIONS_API_KEY is not configured.");
  }

  return `ApiKey ${key}`;
}

function getSchema(subjectType: SubjectType) {
  return subjectType === "individual" ? "Person" : "LegalEntity";
}

function coerceResults(payload: unknown): OpenSanctionsResult[] {
  const record = payload as DynamicRecord;

  if (Array.isArray(record.results)) {
    return record.results as OpenSanctionsResult[];
  }

  if (Array.isArray(record.result)) {
    return record.result as OpenSanctionsResult[];
  }

  if (record.responses && typeof record.responses === "object") {
    const firstResponse = Object.values(record.responses as DynamicRecord)[0] as DynamicRecord | undefined;
    if (firstResponse) {
      if (Array.isArray(firstResponse.results)) {
        return firstResponse.results as OpenSanctionsResult[];
      }
      if (Array.isArray(firstResponse.result)) {
        return firstResponse.result as OpenSanctionsResult[];
      }
    }
  }

  if (Array.isArray(record.matches)) {
    return record.matches as OpenSanctionsResult[];
  }

  return [];
}

function pickName(result: OpenSanctionsResult) {
  return (
    result.caption ||
    result.entity?.caption ||
    result.properties?.name?.[0] ||
    result.entity?.properties?.name?.[0] ||
    result.properties?.alias?.[0] ||
    result.entity?.properties?.alias?.[0] ||
    "Unknown match"
  );
}

function pickDatasets(result: OpenSanctionsResult) {
  return result.datasets || result.entity?.datasets || [];
}

function pickProperties(result: OpenSanctionsResult) {
  return result.properties || result.entity?.properties || {};
}

function pickPositions(result: OpenSanctionsResult) {
  return pickProperties(result).position || [];
}

function pickNotes(result: OpenSanctionsResult) {
  return pickProperties(result).notes || [];
}

function pickBirthDates(result: OpenSanctionsResult) {
  return pickProperties(result).birthDate || [];
}

function prettifyDatasetCode(value: string) {
  const knownLabels: Record<string, string> = {
    wd_peps: "Wikidata politically exposed persons",
    wd_categories: "Wikidata categories",
    wikidata: "Wikidata",
    wd_curated: "Curated public-source screening",
    ann_pep_positions: "PEP officeholder positions",
    sanctions: "Sanctions list",
  };

  if (knownLabels[value]) {
    return knownLabels[value];
  }

  return value
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function formatDatasetList(datasets: string[]) {
  const labels = datasets.map(prettifyDatasetCode);

  if (!labels.length) {
    return "OpenSanctions sources";
  }

  if (labels.length === 1) {
    return labels[0];
  }

  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

function buildOfficeSummary(result: OpenSanctionsResult) {
  const positions = pickPositions(result)
    .filter(Boolean)
    .slice(0, 3);
  const notes = pickNotes(result)
    .filter(Boolean)
    .slice(0, 1);

  if (positions.length) {
    return positions.join("; ");
  }

  return notes[0];
}

function describeMatch(result: OpenSanctionsResult) {
  const datasets = pickDatasets(result);
  const explanationCount = Array.isArray(result.explanations)
    ? result.explanations.length
    : result.explanations && typeof result.explanations === "object"
      ? Object.keys(result.explanations).length
      : 0;
  const datasetLabel = formatDatasetList(datasets.slice(0, 3));
  const officeSummary = buildOfficeSummary(result);

  if (officeSummary && explanationCount > 0) {
    return `Potential match found in ${datasetLabel}. Reported office(s): ${officeSummary}. ${explanationCount} supporting match signal(s).`;
  }

  if (officeSummary) {
    return `Potential match found in ${datasetLabel}. Reported office(s): ${officeSummary}.`;
  }

  if (explanationCount > 0) {
    return `Potential match found in ${datasetLabel} with ${explanationCount} supporting match signal(s).`;
  }

  return `Potential match found in ${datasetLabel}.`;
}

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(value: string) {
  return normalise(value).split(" ").filter(Boolean);
}

function finalToken(value: string) {
  const tokens = tokenise(value);
  return tokens[tokens.length - 1];
}

function exactSurnameMatch(left: string, right: string) {
  const leftSurname = finalToken(left);
  const rightSurname = finalToken(right);

  if (!leftSurname || !rightSurname) {
    return false;
  }

  return leftSurname === rightSurname;
}

function parsePartialDateHint(value?: string) {
  if (!value) {
    return {};
  }

  const trimmed = value.trim();
  const fullDateMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  if (fullDateMatch) {
    return {
      year: fullDateMatch[1],
      month: fullDateMatch[2],
      day: fullDateMatch[3],
    };
  }

  const yearMonthMatch = /^(\d{4})-(\d{2})$/.exec(trimmed);
  if (yearMonthMatch) {
    return {
      year: yearMonthMatch[1],
      month: yearMonthMatch[2],
    };
  }

  const yearOnlyMatch = /^(\d{4})$/.exec(trimmed);
  if (yearOnlyMatch) {
    return {
      year: yearOnlyMatch[1],
    };
  }

  return {};
}

function matchConfidence(score: number): MatchConfidence {
  if (score >= 0.95) {
    return "strong";
  }

  if (score >= 0.75) {
    return "moderate";
  }

  return "weak";
}

function buildMatchReason(result: OpenSanctionsResult, request: ReportRequest) {
  const reasons: string[] = [];
  const resultName = pickName(result);
  const resultTokens = tokenise(resultName);
  const requestTokens = tokenise(request.subject_name);

  if (normalise(resultName) === normalise(request.subject_name)) {
    reasons.push("exact full-name match");
  } else if (requestTokens.length && requestTokens.every((token) => resultTokens.includes(token))) {
    reasons.push("all name tokens matched");
  }

  if (request.date_of_birth) {
    const { year, month, day } = parsePartialDateHint(request.date_of_birth);
    if (year && pickBirthDates(result).some((value) => value.includes(year))) {
      reasons.push("birth-year overlap");
    }
    if (year && month && pickBirthDates(result).some((value) => value.includes(`${year}-${month}`))) {
      reasons.push("birth-month overlap");
    }
    if (
      year &&
      month &&
      day &&
      pickBirthDates(result).some((value) => value.includes(`${year}-${month}-${day}`))
    ) {
      reasons.push("full date-of-birth overlap");
    }
  }

  if (
    request.jurisdiction &&
    pickProperties(result).country?.some(
      (country) =>
        normalise(country).includes(normalise(request.jurisdiction || "")) ||
        normalise(request.jurisdiction || "").includes(normalise(country)),
    )
  ) {
    reasons.push("jurisdiction/country overlap");
  }

  return reasons.length ? reasons.join("; ") : "OpenSanctions similarity match";
}

function mapMatch(result: OpenSanctionsResult, request: ReportRequest): SanctionsMatch {
  const score = typeof result.score === "number" ? result.score : 0;
  const datasets = pickDatasets(result);
  const primaryDataset = prettifyDatasetCode(datasets[0] || "OpenSanctions");
  const hasExactSurname = request.subject_type !== "individual" || exactSurnameMatch(pickName(result), request.subject_name);
  const reason = buildMatchReason(result, request);
  const effectiveScore = request.subject_type === "individual" && !hasExactSurname
    ? Math.min(score, 0.74)
    : score;

  return {
    entity_name: pickName(result),
    dataset: primaryDataset,
    score: effectiveScore,
    status: effectiveScore >= 0.95 ? "confirmed_match" : effectiveScore >= 0.7 ? "potential_match" : "clear",
    detail: describeMatch(result),
    office_summary: buildOfficeSummary(result),
    match_reason: hasExactSurname ? reason : `${reason}; surname mismatch`,
    match_confidence: matchConfidence(effectiveScore),
  };
}

export async function screenWithOpenSanctions(request: ReportRequest): Promise<{
  matches: SanctionsMatch[];
  listsChecked: number;
  status: "clear" | "potential_match" | "confirmed_match";
  sources: Source[];
}> {
  const schema = getSchema(request.subject_type);
  const payload = await (async () => {
    const response = await fetch(`${BASE_URL}/match/default`, {
      method: "POST",
      headers: {
        Authorization: getAuthHeader(),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
      body: JSON.stringify({
        queries: {
          q1: {
            schema,
            properties: {
              name: [request.subject_name],
              ...(request.date_of_birth ? { birthDate: [request.date_of_birth] } : {}),
              ...(request.jurisdiction ? { country: [request.jurisdiction.toUpperCase()] } : {}),
            },
          },
        },
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenSanctions request failed (${response.status}) for /match/default`);
    }

    return response.json();
  })();

  const matches = coerceResults(payload)
    .map((result) => mapMatch(result, request))
    .filter((match) => {
      if (match.score < 0.5) {
        return false;
      }

      if (request.subject_type !== "individual") {
        return true;
      }

      const nameTokens = tokenise(match.entity_name);
      const requestTokens = tokenise(request.subject_name);
      const allNameTokensMatch =
        requestTokens.length > 0 && requestTokens.every((token) => nameTokens.includes(token));
      const sameSurname = exactSurnameMatch(match.entity_name, request.subject_name);

      if (!sameSurname) {
        return false;
      }

      if (!allNameTokensMatch && match.score < 0.85) {
        return false;
      }

      return true;
    })
    .sort((left, right) => right.score - left.score)
    .slice(0, 5);

  const status = matches.some((match) => match.status === "confirmed_match")
    ? "confirmed_match"
    : matches.some((match) => match.status === "potential_match")
      ? "potential_match"
      : "clear";

  return {
    matches,
    listsChecked: 1500,
    status,
    sources: [
      {
        url: `${BASE_URL}/match/default`,
        title: "OpenSanctions match API",
        type: "watchlist",
        accessed_at: new Date().toISOString(),
      },
    ],
  };
}

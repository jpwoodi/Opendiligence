import type { ReportRequest, SanctionsMatch, Source, SubjectProfile } from "@/lib/types";

const MEMBERS_API_BASE = "https://members-api.parliament.uk/api";

type SearchPayload = {
  items?: Array<{
    value?: {
      id?: number;
      nameDisplayAs?: string;
      nameFullTitle?: string;
      latestHouseMembership?: {
        membershipFrom?: string;
        membershipStatus?: {
          statusIsActive?: boolean;
        };
      };
    };
  }>;
};

type SynopsisPayload = {
  value?: string;
};

function normalise(value: string) {
  return value
    .toLowerCase()
    .replace(/\b(rt hon|right honourable|sir|dame|lord|lady|baroness|baron|mp|kc|kcb)\b/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function nameMatches(requestName: string, candidateName: string) {
  return normalise(requestName) === normalise(candidateName);
}

function parseCurrentRoleSummary(synopsis: string) {
  const cleaned = synopsis.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  const roles: string[] = [];

  const governmentPost = /currently holds the Government post of ([^.]+)\./i.exec(cleaned)?.[1]?.trim();
  if (governmentPost) {
    roles.push(governmentPost);
  }

  const additionalLeadership = /In addition, (?:he|she) is ([^.]+)\./i.exec(cleaned)?.[1]?.trim();
  if (additionalLeadership) {
    roles.push(additionalLeadership);
  }

  return {
    cleaned,
    officeSummary: roles.join("; "),
  };
}

export async function fetchUkParliamentCurrentRole(request: ReportRequest): Promise<{
  subjectProfile: Pick<SubjectProfile, "headline" | "known_for" | "locations">;
  officeSummary: string;
  sources: Source[];
} | null> {
  if (request.subject_type !== "individual") {
    return null;
  }

  if (request.jurisdiction && request.jurisdiction !== "gb") {
    return null;
  }

  const searchResponse = await fetch(
    `${MEMBERS_API_BASE}/Members/Search?Name=${encodeURIComponent(request.subject_name)}`,
    {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!searchResponse.ok) {
    throw new Error(`UK Parliament member search failed (${searchResponse.status}).`);
  }

  const searchPayload = (await searchResponse.json()) as SearchPayload;
  const candidate = (searchPayload.items || []).find((item) => {
    const member = item.value;
    if (!member?.id || !member.latestHouseMembership?.membershipStatus?.statusIsActive) {
      return false;
    }

    return nameMatches(
      request.subject_name,
      member.nameDisplayAs || member.nameFullTitle || "",
    );
  })?.value;

  if (!candidate?.id) {
    return null;
  }

  const synopsisResponse = await fetch(
    `${MEMBERS_API_BASE}/Members/${candidate.id}/Synopsis`,
    {
      headers: {
        Accept: "application/json",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10000),
    },
  );

  if (!synopsisResponse.ok) {
    throw new Error(`UK Parliament synopsis lookup failed (${synopsisResponse.status}).`);
  }

  const synopsisPayload = (await synopsisResponse.json()) as SynopsisPayload;
  const synopsis = synopsisPayload.value?.trim();

  if (!synopsis) {
    return null;
  }

  const parsed = parseCurrentRoleSummary(synopsis);
  if (!parsed.officeSummary) {
    return null;
  }

  return {
    subjectProfile: {
      headline: `${request.subject_name} currently holds UK public office as ${parsed.officeSummary}.`,
      known_for: [parsed.officeSummary],
      locations: ["United Kingdom"],
    },
    officeSummary: parsed.officeSummary,
    sources: [
      {
        url: `${MEMBERS_API_BASE}/Members/Search?Name=${encodeURIComponent(request.subject_name)}`,
        title: `UK Parliament member search for ${request.subject_name}`,
        type: "regulatory",
        accessed_at: new Date().toISOString(),
      },
      {
        url: `${MEMBERS_API_BASE}/Members/${candidate.id}/Synopsis`,
        title: `UK Parliament synopsis for ${request.subject_name}`,
        type: "regulatory",
        accessed_at: new Date().toISOString(),
      },
    ],
  };
}

export function applyUkCurrentRoleToSanctionsMatches(
  matches: SanctionsMatch[],
  requestName: string,
  officeSummary: string,
) {
  return matches.map((match) => {
    if (!nameMatches(requestName, match.entity_name)) {
      return match;
    }

    return {
      ...match,
      office_summary: officeSummary,
      detail: `${match.detail} Current official role per UK Parliament: ${officeSummary}.`,
    };
  });
}

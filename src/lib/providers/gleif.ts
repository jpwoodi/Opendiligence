import type { Association, ReportRequest, Source } from "@/lib/types";

const BASE_URL = "https://api.gleif.org/api/v1";

interface LeiRecord {
  id?: string;
  attributes?: {
    lei?: string;
    entity?: {
      legalName?: {
        name?: string;
      };
      legalAddress?: {
        addressLines?: string[];
        city?: string;
        country?: string;
        postalCode?: string;
      };
      jurisdiction?: string;
      registeredAs?: string;
      status?: string;
    };
    registration?: {
      status?: string;
      lastUpdateDate?: string;
      nextRenewalDate?: string;
      corroborationLevel?: string;
    };
  };
}

interface GLEIFSearchResponse {
  data?: LeiRecord[];
}

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(value: string) {
  return normalise(value).split(" ").filter(Boolean);
}

function formatAddress(record: LeiRecord) {
  const address = record.attributes?.entity?.legalAddress;
  if (!address) {
    return undefined;
  }

  return [...(address.addressLines || []), address.city, address.postalCode, address.country]
    .filter(Boolean)
    .join(", ");
}

function scoreRecord(record: LeiRecord, request: ReportRequest) {
  const name = record.attributes?.entity?.legalName?.name || "";
  const queryTokens = tokenise(request.subject_name);
  const nameTokens = tokenise(name);
  let score = 0;

  if (normalise(name) === normalise(request.subject_name)) {
    score += 50;
  }

  if (queryTokens.length && queryTokens.every((token) => nameTokens.includes(token))) {
    score += 25;
  }

  if (
    request.company_number &&
    record.attributes?.entity?.registeredAs &&
    record.attributes.entity.registeredAs.replace(/^0+/, "") === request.company_number.replace(/^0+/, "")
  ) {
    score += 30;
  }

  if (
    request.jurisdiction &&
    record.attributes?.entity?.jurisdiction?.toLowerCase() === request.jurisdiction.toLowerCase()
  ) {
    score += 10;
  }

  return score;
}

async function gleifFetch<T>(path: string) {
  const response = await fetch(`${BASE_URL}${path}`, {
    headers: {
      Accept: "application/vnd.api+json",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`GLEIF request failed (${response.status}) for ${path}`);
  }

  return (await response.json()) as T;
}

function buildLeiUrl(lei: string) {
  return `https://search.gleif.org/#/record/${lei}`;
}

function buildBaseAssociation(record: LeiRecord): Association {
  const lei = record.attributes?.lei || record.id || "Unknown LEI";
  const name = record.attributes?.entity?.legalName?.name || "GLEIF legal entity";
  const registration = record.attributes?.registration;
  const entity = record.attributes?.entity;
  const detailParts = [
    `GLEIF LEI ${lei} identifies ${name}.`,
    entity?.registeredAs ? `Registered as ${entity.registeredAs}.` : undefined,
    entity?.jurisdiction ? `Jurisdiction ${entity.jurisdiction}.` : undefined,
    entity?.status ? `Entity status ${entity.status}.` : undefined,
    registration?.corroborationLevel ? `Corroboration ${registration.corroborationLevel}.` : undefined,
    formatAddress(record) ? `Address ${formatAddress(record)}.` : undefined,
  ].filter(Boolean);

  return {
    subject: name,
    relationship: "GLEIF LEI record",
    detail: detailParts.join(" "),
    source_url: buildLeiUrl(lei),
  };
}

function buildParentAssociation(kind: "Direct parent" | "Ultimate parent", record: LeiRecord): Association {
  const lei = record.attributes?.lei || record.id || "Unknown LEI";
  const name = record.attributes?.entity?.legalName?.name || kind;
  const registration = record.attributes?.entity?.registeredAs;

  return {
    subject: name,
    relationship: kind,
    detail: [
      `${kind} relationship surfaced through GLEIF Level 2 parent data.`,
      `LEI ${lei}.`,
      registration ? `Registered as ${registration}.` : undefined,
      formatAddress(record) ? `Address ${formatAddress(record)}.` : undefined,
    ]
      .filter(Boolean)
      .join(" "),
    source_url: buildLeiUrl(lei),
  };
}

export async function researchWithGleif(request: ReportRequest): Promise<{
  associations: Association[];
  sources: Source[];
}> {
  if (request.subject_type !== "organisation") {
    return {
      associations: [],
      sources: [],
    };
  }

  const search = await gleifFetch<GLEIFSearchResponse>(
    `/lei-records?filter[entity.legalName]=${encodeURIComponent(request.subject_name)}&page[size]=5`,
  );
  const top = (search.data || [])
    .map((record) => ({ record, score: scoreRecord(record, request) }))
    .sort((left, right) => right.score - left.score)[0]?.record;

  if (!top?.id) {
    return {
      associations: [],
      sources: [],
    };
  }

  const [directParent, ultimateParent] = await Promise.all([
    gleifFetch<{ data?: LeiRecord }>(`/lei-records/${top.id}/direct-parent`).catch(() => ({ data: undefined })),
    gleifFetch<{ data?: LeiRecord }>(`/lei-records/${top.id}/ultimate-parent`).catch(() => ({ data: undefined })),
  ]);

  const associations = [
    buildBaseAssociation(top),
    directParent.data ? buildParentAssociation("Direct parent", directParent.data) : null,
    ultimateParent.data ? buildParentAssociation("Ultimate parent", ultimateParent.data) : null,
  ].filter(Boolean) as Association[];

  const now = new Date().toISOString();
  const sourceRecords = [top, directParent.data, ultimateParent.data].filter(Boolean) as LeiRecord[];
  const sources = sourceRecords.map((record) => {
    const lei = record.attributes?.lei || record.id || "Unknown LEI";
    const name = record.attributes?.entity?.legalName?.name || lei;

    return {
      url: buildLeiUrl(lei),
      title: `GLEIF LEI record for ${name}`,
      type: "corporate_registry" as const,
      accessed_at: now,
    };
  });

  return {
    associations,
    sources,
  };
}

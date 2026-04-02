import { JSDOM } from "jsdom";

import type { MediaFinding, ReportRequest, Source } from "@/lib/types";

const BASE_URL = "https://www.fca.org.uk";
const SEARCH_URL = `${BASE_URL}/consumers/warning-list-unauthorised-firms`;

interface WarningSearchHit {
  title: string;
  url: string;
}

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(value: string) {
  return normalise(value).split(" ").filter(Boolean);
}

function scoreHit(title: string, request: ReportRequest) {
  const queryTokens = tokenise(request.subject_name);
  const titleTokens = tokenise(title);
  let score = 0;

  if (queryTokens.length && queryTokens.every((token) => titleTokens.includes(token))) {
    score += 30;
  }

  if (normalise(title).includes(normalise(request.subject_name))) {
    score += 20;
  }

  if (title.toLowerCase().includes("clone")) {
    score += 5;
  }

  return score;
}

async function fetchHtml(url: string) {
  const response = await fetch(url, {
    headers: {
      "User-Agent": "OpenDiligenceBot/0.1 (+prototype due diligence research)",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`FCA request failed (${response.status}) for ${url}`);
  }

  return response.text();
}

function parseSearchHits(html: string): WarningSearchHit[] {
  const dom = new JSDOM(html, { url: SEARCH_URL });
  const links = [...dom.window.document.querySelectorAll("table.views-table tbody tr a")]
    .map((link) => ({
      title: link.textContent?.trim() || "",
      url: new URL((link as HTMLAnchorElement).href, BASE_URL).toString(),
    }))
    .filter((link) => link.title && link.url.startsWith(BASE_URL));

  return links;
}

function extractMeta(html: string, name: string, property = false) {
  const dom = new JSDOM(html);
  const selector = property ? `meta[property="${name}"]` : `meta[name="${name}"]`;
  return dom.window.document.querySelector(selector)?.getAttribute("content")?.trim();
}

async function enrichHit(hit: WarningSearchHit) {
  const html = await fetchHtml(hit.url);
  const description =
    extractMeta(html, "og:description", true) ||
    extractMeta(html, "description") ||
    "FCA warning page for a potentially unauthorised or clone firm.";
  const updated =
    extractMeta(html, "article:modified_time", true) ||
    extractMeta(html, "article:published_time", true) ||
    new Date().toISOString();

  return {
    ...hit,
    description,
    updated,
  };
}

export async function researchWithFcaWarnings(request: ReportRequest): Promise<{
  adverseMedia: MediaFinding[];
  sources: Source[];
}> {
  const html = await fetchHtml(`${SEARCH_URL}?search=${encodeURIComponent(request.subject_name)}`);
  const hits = parseSearchHits(html)
    .map((hit) => ({ hit, score: scoreHit(hit.title, request) }))
    .filter((entry) => entry.score >= 20)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map((entry) => entry.hit);

  if (!hits.length) {
    return {
      adverseMedia: [],
      sources: [],
    };
  }

  const detailedHits = await Promise.all(hits.map((hit) => enrichHit(hit).catch(() => null)));
  const usableHits = detailedHits.filter(Boolean) as Array<
    WarningSearchHit & { description: string; updated: string }
  >;
  const now = new Date().toISOString();

  return {
    adverseMedia: usableHits.map((hit) => ({
      summary: hit.description,
      risk_category: "fca_warning_list",
      severity: "high" as const,
      source_url: hit.url,
      source_title: `FCA Warning List: ${hit.title}`,
      date: hit.updated.slice(0, 10),
    })),
    sources: usableHits.map((hit) => ({
      url: hit.url,
      title: `FCA Warning List entry for ${hit.title}`,
      type: "regulatory" as const,
      accessed_at: now,
    })),
  };
}

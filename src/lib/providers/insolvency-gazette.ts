import { JSDOM } from "jsdom";

import type { MediaFinding, ReportRequest, RiskLevel, Source } from "@/lib/types";

const BASE_URL = "https://www.thegazette.co.uk";
const SEARCH_URL = `${BASE_URL}/insolvency/notice`;

interface GazetteHit {
  title: string;
  url: string;
  date: string;
  noticeType: string;
  summary: string;
}

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ").replace(/\s+/g, " ").trim();
}

function tokenise(value: string) {
  return normalise(value).split(" ").filter(Boolean);
}

function buildSearchUrl(request: ReportRequest) {
  const params = new URLSearchParams();
  params.set(
    "text",
    request.subject_type === "organisation" && request.company_number?.trim()
      ? `${request.subject_name} ${request.company_number.trim()}`
      : request.subject_name,
  );
  params.set(
    request.subject_type === "organisation" ? "insolvency_corporate" : "insolvency_personal",
    request.subject_type === "organisation" ? "G205010000" : "G206030000",
  );
  params.set("results-page-size", "20");

  return `${SEARCH_URL}?${params.toString()}`;
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
    throw new Error(`Gazette request failed (${response.status}) for ${url}`);
  }

  return response.text();
}

function parseHits(html: string, request: ReportRequest): GazetteHit[] {
  const dom = new JSDOM(html, { url: SEARCH_URL });
  const resultCountText =
    dom.window.document.querySelector(".number-notices")?.textContent?.toLowerCase() || "";

  if (resultCountText.includes("0 results")) {
    return [];
  }

  return [...dom.window.document.querySelectorAll('article[id^="item-"]')]
    .map((article) => {
      const titleLink = article.querySelector("h3.title a");
      const time = article.querySelector("time");
      const noticeType = [...article.querySelectorAll("dt, dd")].reduce<string | null>(
        (current, element, index, items) => {
          if (element.textContent?.trim() !== "Notice Type") {
            return current;
          }

          return items[index + 1]?.textContent?.replace(/\s+/g, " ").trim() || null;
        },
        null,
      );
      const summary =
        article.querySelector(".content p")?.textContent?.replace(/\s+/g, " ").trim() || "";

      return {
        title: titleLink?.textContent?.trim() || "",
        url: new URL(titleLink?.getAttribute("href") || "", BASE_URL).toString(),
        date: time?.getAttribute("datetime")?.slice(0, 10) || new Date().toISOString().slice(0, 10),
        noticeType: noticeType || "Insolvency notice",
        summary,
      };
    })
    .filter((hit) => hit.title && hit.url.startsWith(BASE_URL))
    .filter((hit) => scoreHit(hit, request) >= 18);
}

function scoreHit(hit: GazetteHit, request: ReportRequest) {
  const subjectTokens = tokenise(request.subject_name);
  const titleTokens = tokenise(hit.title);
  const summaryTokens = tokenise(hit.summary);
  const combined = new Set([...titleTokens, ...summaryTokens]);
  let score = 0;

  if (request.company_number?.trim() && hit.summary.includes(request.company_number.trim())) {
    score += 50;
  }

  if (subjectTokens.length && subjectTokens.every((token) => combined.has(token))) {
    score += 30;
  }

  if (normalise(hit.title).includes(normalise(request.subject_name))) {
    score += 20;
  }

  if (normalise(hit.summary).includes(normalise(request.subject_name))) {
    score += 15;
  }

  if (/winding up|liquidat|bankrupt|administration|sequestration/i.test(hit.noticeType)) {
    score += 8;
  }

  return score;
}

function deriveRiskLevel(hits: GazetteHit[]): RiskLevel {
  if (
    hits.some((hit) =>
      /winding up|winding-up|bankruptcy order|bankrupt|sequestration|liquidator/i.test(hit.noticeType),
    )
  ) {
    return "red";
  }

  return hits.length ? "amber" : "green";
}

export async function researchWithInsolvencyGazette(request: ReportRequest): Promise<{
  findings: MediaFinding[];
  sources: Source[];
  riskLevel: RiskLevel;
}> {
  const html = await fetchHtml(buildSearchUrl(request));
  const hits = parseHits(html, request).slice(0, 3);

  if (!hits.length) {
    return {
      findings: [],
      sources: [],
      riskLevel: "green",
    };
  }

  const now = new Date().toISOString();

  return {
    findings: hits.map((hit) => ({
      summary: `${hit.noticeType} published in The Gazette for ${hit.title}. ${hit.summary}`.trim(),
      risk_category: "insolvency",
      severity: deriveRiskLevel([hit]) === "red" ? "high" : "medium",
      source_url: hit.url,
      source_title: `The Gazette insolvency notice: ${hit.title}`,
      date: hit.date,
    })),
    sources: hits.map((hit) => ({
      url: hit.url,
      title: `The Gazette insolvency notice for ${hit.title}`,
      type: "regulatory",
      accessed_at: now,
    })),
    riskLevel: deriveRiskLevel(hits),
  };
}

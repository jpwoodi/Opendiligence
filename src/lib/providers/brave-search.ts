import { Readability } from "@mozilla/readability";
import { JSDOM } from "jsdom";
import { createRequire } from "module";
import OpenAI from "openai";

import { env, hasOpenAiConfig } from "@/lib/env";
import { ALTERNATIVE_DATA_SUMMARY_PROMPT, MEDIA_TRIAGE_PROMPT } from "@/lib/prompts";
import { withTimeout } from "@/lib/timeout";
import type { AlternativeDataSummary, MediaFinding, ReportRequest, Source } from "@/lib/types";

const require = createRequire(import.meta.url);

const BASE_URL = "https://api.search.brave.com/res/v1/web/search";
const MAX_EXTRACTED_CHARS = 5000;
const MAX_TRIAGE_CANDIDATES = 18;
const NEGATIVE_POSITIVE_MEDIA_TERMS = [
  "fraud",
  "investigation",
  "lawsuit",
  "sanction",
  "money laundering",
  "bribery",
  "corruption",
  "putin",
  "russian government fund",
  "oligarch",
  "crime",
  "criminal",
  "charged",
  "accused",
  "probe",
  "controversy",
  "scandal",
];
const NON_ARTICLE_HOSTS = [
  "crunchbase.com",
  "linkedin.com",
  "bloomberg.com/profile",
  "pitchbook.com",
  "companieshouse.gov.uk",
];
const BACKGROUND_ONLY_HOSTS = [
  "wikipedia.org",
];
const ALTERNATIVE_DATA_HOSTS = [
  "x.com",
  "twitter.com",
  "substack.com",
  "medium.com",
  "youtube.com",
  "youtu.be",
  "tiktok.com",
  "instagram.com",
  "facebook.com",
  "reddit.com",
];
const NON_ARTICLE_TITLE_TERMS = [
  "profile",
  "person profile",
  "company profile",
  "founder @",
  "leadership team",
  "team",
  "directory",
  "biography",
  "bio",
  "speaker",
  "speakers",
  "agenda",
  "program",
  "programme",
  "summit",
  "conference",
  "forum",
  "panel",
  "session",
  "event",
];

let openaiClient: OpenAI | null = null;

function getOpenAiClient() {
  if (!env.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
  }

  if (!openaiClient) {
    openaiClient = new OpenAI({
      apiKey: env.openAiApiKey,
    });
  }

  return openaiClient;
}

interface BraveSearchResult {
  title?: string;
  url?: string;
  description?: string;
  age?: string;
  page_age?: string;
  extra_snippets?: string[];
}

interface BraveSearchResponse {
  web?: {
    results?: BraveSearchResult[];
  };
}

interface MediaTriageDecision {
  url: string;
  bucket: "adverse" | "positive" | "ignore";
  risk_category: string;
  severity: "low" | "medium" | "high";
  reason: string;
}

export interface MediaEvidence {
  url: string;
  title: string;
  snippet: string;
  extracted_text: string;
  date: string;
  content_type: string;
}

function getAuthHeader() {
  const key = env.braveSearchApiKey;
  if (!key) {
    throw new Error("BRAVE_SEARCH_API_KEY is not configured.");
  }

  return key;
}

async function braveFetch(query: string, count = 5, freshness?: "pd" | "pw" | "pm" | "py") {
  const params = new URLSearchParams({
    q: query,
    count: String(count),
    search_lang: "en",
    country: "gb",
    safesearch: "moderate",
  });

  if (freshness) {
    params.set("freshness", freshness);
  }

  const response = await fetch(`${BASE_URL}?${params.toString()}`, {
    headers: {
      "X-Subscription-Token": getAuthHeader(),
      Accept: "application/json",
      "Accept-Encoding": "gzip",
    },
    cache: "no-store",
    signal: AbortSignal.timeout(10000),
  });

  if (!response.ok) {
    throw new Error(`Brave Search request failed (${response.status}) for query "${query}"`);
  }

  return (await response.json()) as BraveSearchResponse;
}

function normaliseDate(result: BraveSearchResult) {
  return result.page_age || result.age || new Date().toISOString().slice(0, 10);
}

function buildSnippet(result: BraveSearchResult) {
  const parts = [result.description, ...(result.extra_snippets || []).slice(0, 1)].filter(Boolean);
  return parts.join(" ").trim() || "Search result returned without a usable snippet.";
}

function normaliseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function normaliseForMatch(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function dedupeEvidence(items: MediaEvidence[]) {
  return items.filter(
    (item, index, all) => all.findIndex((entry) => entry.url === item.url) === index,
  );
}

function isBackgroundOnlySource(evidence: MediaEvidence) {
  const lowerUrl = evidence.url.toLowerCase();
  return BACKGROUND_ONLY_HOSTS.some((host) => lowerUrl.includes(host));
}

function isAlternativeDataSource(evidence: MediaEvidence) {
  const lowerUrl = evidence.url.toLowerCase();
  return ALTERNATIVE_DATA_HOSTS.some((host) => lowerUrl.includes(host));
}

function dateRank(value: string) {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortByDate<T extends { date: string }>(items: T[]) {
  return items.slice().sort((left, right) => dateRank(right.date) - dateRank(left.date));
}

export function looksLikeNonArticle(evidence: MediaEvidence) {
  const lowerUrl = evidence.url.toLowerCase();
  const lowerTitle = evidence.title.toLowerCase();
  const lowerSnippet = evidence.snippet.toLowerCase();
  const lowerText = `${lowerTitle} ${lowerSnippet} ${evidence.extracted_text.toLowerCase()}`;

  if (NON_ARTICLE_HOSTS.some((host) => lowerUrl.includes(host))) {
    return true;
  }

  if (NON_ARTICLE_TITLE_TERMS.some((term) => lowerTitle.includes(term))) {
    return true;
  }

  if (
    /people\/|person\/|profile\/|team\/|leadership\/|biography\/|bio\/|directory\/|speakers?\/|events?\/|agenda\/|programme\/|program\/|summit\/|conference\//.test(lowerUrl)
  ) {
    return true;
  }

  if (
    lowerSnippet.includes("person profile") ||
    lowerSnippet.includes("company profile") ||
    lowerSnippet.includes("founder @")
  ) {
    return true;
  }

  if (
    (lowerText.includes("former") || lowerText.includes("chairman") || lowerText.includes("commissioner")) &&
    (lowerText.includes("speaker") ||
      lowerText.includes("session") ||
      lowerText.includes("summit") ||
      lowerText.includes("conference") ||
      lowerText.includes("milken institute"))
  ) {
    return true;
  }

  return false;
}

function toBuffer(input: ArrayBuffer) {
  return Buffer.from(input);
}

function fallbackTextFromHtml(html: string) {
  return normaliseWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&quot;/gi, "\"")
      .replace(/&#39;/gi, "'"),
  ).slice(0, MAX_EXTRACTED_CHARS);
}

function extractWithReadability(html: string, url: string) {
  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const content = article?.textContent || dom.window.document.body?.textContent || "";
    return normaliseWhitespace(content).slice(0, MAX_EXTRACTED_CHARS);
  } catch {
    return fallbackTextFromHtml(html);
  }
}

function loadPdfParse() {
  return require("pdf-parse") as typeof import("pdf-parse");
}

async function fetchExtractedText(url: string) {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "OpenDiligenceBot/0.1 (+prototype due diligence research)",
      },
      redirect: "follow",
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      return { text: "", contentType: "" };
    }

    const contentType = response.headers.get("content-type") || "";
    if (contentType.includes("application/pdf") || url.toLowerCase().endsWith(".pdf")) {
      const { PDFParse } = loadPdfParse();
      const parser = new PDFParse({ data: toBuffer(await response.arrayBuffer()) });

      try {
        const parsed = await parser.getText();
        return {
          text: normaliseWhitespace(parsed.text || "").slice(0, MAX_EXTRACTED_CHARS),
          contentType,
        };
      } finally {
        await parser.destroy();
      }
    }

    if (!contentType.includes("text/html")) {
      return { text: "", contentType };
    }

    const html = await response.text();
    return {
      text: extractWithReadability(html, url),
      contentType,
    };
  } catch {
    return { text: "", contentType: "" };
  }
}

function evidenceToFinding(
  evidence: MediaEvidence,
  riskCategory: string,
  severity: "low" | "medium" | "high",
): MediaFinding {
  return {
    summary: evidence.snippet,
    risk_category: riskCategory,
    severity,
    source_url: evidence.url,
    source_title: evidence.title,
    date: evidence.date,
  };
}

async function triageEvidenceWithOpenAi(
  request: ReportRequest,
  evidence: MediaEvidence[],
): Promise<MediaTriageDecision[] | null> {
  if (!hasOpenAiConfig() || !evidence.length) {
    return null;
  }

  const response = await withTimeout(
    getOpenAiClient().responses.create({
      model: env.openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: MEDIA_TRIAGE_PROMPT,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                request,
                evidence: evidence.slice(0, MAX_TRIAGE_CANDIDATES).map((item) => ({
                  url: item.url,
                  title: item.title,
                  snippet: item.snippet,
                  extracted_text: item.extracted_text.slice(0, 1200),
                  date: item.date,
                })),
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "media_triage",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              decisions: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    url: { type: "string" },
                    bucket: { type: "string", enum: ["adverse", "positive", "ignore"] },
                    risk_category: { type: "string" },
                    severity: { type: "string", enum: ["low", "medium", "high"] },
                    reason: { type: "string" },
                  },
                  required: ["url", "bucket", "risk_category", "severity", "reason"],
                },
              },
            },
            required: ["decisions"],
          },
        },
      },
    }),
    18000,
    "Media triage",
  );

  if (!response.output_text) {
    return null;
  }

  return (JSON.parse(response.output_text) as { decisions: MediaTriageDecision[] }).decisions;
}

async function summarizeAlternativeDataWithOpenAi(
  request: ReportRequest,
  evidence: MediaEvidence[],
): Promise<AlternativeDataSummary | undefined> {
  if (!hasOpenAiConfig() || !evidence.length) {
    return undefined;
  }

  const response = await withTimeout(
    getOpenAiClient().responses.create({
      model: env.openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: ALTERNATIVE_DATA_SUMMARY_PROMPT,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                request,
                evidence: evidence.slice(0, 6).map((item) => ({
                  url: item.url,
                  title: item.title,
                  snippet: item.snippet,
                  extracted_text: item.extracted_text.slice(0, 1000),
                  date: item.date,
                })),
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "alternative_data_summary",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              text: { type: "string" },
              citation_urls: {
                type: "array",
                items: { type: "string" },
              },
            },
            required: ["text", "citation_urls"],
          },
        },
      },
    }),
    18000,
    "Alternative data summary",
  );

  if (!response.output_text) {
    return undefined;
  }

  const parsed = JSON.parse(response.output_text) as {
    text: string;
    citation_urls: string[];
  };
  const evidenceByUrl = new Map(evidence.map((item) => [item.url, item]));

  return {
    text: parsed.text,
    citations: parsed.citation_urls
      .map((url) => evidenceByUrl.get(url))
      .filter(Boolean)
      .map((item) => ({
        url: item!.url,
        title: item!.title,
      })),
  };
}

function evidenceToSource(evidence: MediaEvidence): Source {
  return {
    url: evidence.url,
    title: evidence.title,
    type: isBackgroundOnlySource(evidence)
      ? "background"
      : isAlternativeDataSource(evidence)
        ? "alternative"
      : evidence.content_type.includes("pdf")
        ? "regulatory"
        : "news",
    accessed_at: new Date().toISOString(),
  };
}

async function toEvidence(results: BraveSearchResult[]) {
  const sliced = results.filter((result) => result.url && result.title).slice(0, 4);
  const extractedTexts = await Promise.all(
    sliced.map((result) => fetchExtractedText(result.url as string)),
  );

  return sliced.map((result, index) => ({
    url: result.url as string,
    title: result.title as string,
    snippet: buildSnippet(result),
    extracted_text: extractedTexts[index]?.text || "",
    date: normaliseDate(result),
    content_type: extractedTexts[index]?.contentType || "",
  }));
}

export function findingsFromEvidence(
  evidence: MediaEvidence[],
  riskCategory: string,
  severity: "low" | "medium" | "high",
) {
  return evidence
    .map((item) => evidenceToFinding(item, riskCategory, severity))
    .slice(0, riskCategory === "adverse_media" ? 4 : 3);
}

function filterPositiveEvidence(evidence: MediaEvidence[]) {
  return evidence.filter((item) => {
    if (isBackgroundOnlySource(item)) {
      return false;
    }

    if (isAlternativeDataSource(item)) {
      return false;
    }

    if (looksLikeNonArticle(item)) {
      return false;
    }

    const haystack = normaliseForMatch(
      `${item.title} ${item.snippet} ${item.extracted_text}`,
    );

    return !NEGATIVE_POSITIVE_MEDIA_TERMS.some((term) => haystack.includes(term));
  });
}

function filterAdverseEvidence(evidence: MediaEvidence[]) {
  return evidence.filter(
    (item) =>
      !looksLikeNonArticle(item) &&
      !isBackgroundOnlySource(item) &&
      !isAlternativeDataSource(item),
  );
}

export async function researchWithBrave(request: ReportRequest): Promise<{
  adverseMedia: MediaFinding[];
  positiveMedia: MediaFinding[];
  adverseEvidence: MediaEvidence[];
  positiveEvidence: MediaEvidence[];
  sources: Source[];
  alternativeSources: Source[];
  alternativeDataSummary?: AlternativeDataSummary;
  triageMode: "llm" | "heuristic";
}> {
  const context = request.additional_context?.trim()
    ? ` ${request.additional_context.trim()}`
    : "";
  const adverseQuery =
    `"${request.subject_name}"${context} fraud OR investigation OR lawsuit OR sanction OR corruption OR bribery OR controversy`;
  const reputationalQuery =
    `"${request.subject_name}"${context} controversy OR complaint OR dispute OR criticism OR objection OR planning OR outrage OR protest`;
  const positiveQuery =
    request.subject_type === "individual"
      ? `"${request.subject_name}"${context} award OR philanthropy OR founder OR chairman OR compliance -fraud -investigation -lawsuit -sanction`
      : `"${request.subject_name}"${context} award OR philanthropy OR expansion OR compliance -fraud -investigation -lawsuit -sanction`;
  const generalQuery = `"${request.subject_name}"${context}`;
  const recentQuery = `"${request.subject_name}"${context} news OR latest OR update`;
  const xQuery = `"${request.subject_name}"${context} site:x.com OR site:twitter.com`;

  const [adverseResponse, reputationalResponse, positiveResponse, generalResponse, recentResponse, xResponse] =
    await Promise.all([
      withTimeout(braveFetch(adverseQuery, 8), 12000, "Brave adverse search"),
      withTimeout(braveFetch(reputationalQuery, 8), 12000, "Brave reputational search"),
      withTimeout(braveFetch(positiveQuery, 6), 12000, "Brave positive search"),
      withTimeout(braveFetch(generalQuery, 8), 12000, "Brave general search"),
      withTimeout(braveFetch(recentQuery, 10, "pm"), 12000, "Brave recent search"),
      withTimeout(braveFetch(xQuery, 10, "pm"), 12000, "Brave X search"),
    ]);

  const [adverseCandidates, reputationalCandidates, positiveCandidates, generalCandidates, recentCandidates, xCandidates] =
    await Promise.all([
      withTimeout(toEvidence(adverseResponse.web?.results || []), 15000, "Adverse extraction"),
      withTimeout(toEvidence(reputationalResponse.web?.results || []), 15000, "Reputational extraction"),
      withTimeout(toEvidence(positiveResponse.web?.results || []), 15000, "Positive extraction"),
      withTimeout(toEvidence(generalResponse.web?.results || []), 15000, "General extraction"),
      withTimeout(toEvidence(recentResponse.web?.results || []), 15000, "Recent extraction"),
      withTimeout(toEvidence(xResponse.web?.results || []), 15000, "X extraction"),
    ]);

  const candidateEvidence = sortByDate(dedupeEvidence([
    ...adverseCandidates,
    ...reputationalCandidates,
    ...positiveCandidates,
    ...generalCandidates,
    ...recentCandidates,
    ...xCandidates,
  ]));
  const articleEvidence = candidateEvidence.filter((item) => !looksLikeNonArticle(item));
  const triageDecisions = await triageEvidenceWithOpenAi(request, articleEvidence).catch(() => null);

  let filteredAdverseEvidence: MediaEvidence[];
  let filteredPositiveEvidence: MediaEvidence[];
  let adverseMedia: MediaFinding[];
  let positiveMedia: MediaFinding[];
  const alternativeEvidence = dedupeEvidence(candidateEvidence.filter(isAlternativeDataSource));
  const alternativeSources = alternativeEvidence.map(evidenceToSource);
  const alternativeDataSummary = await summarizeAlternativeDataWithOpenAi(request, alternativeEvidence).catch(() => undefined);

  if (triageDecisions?.length) {
    const evidenceByUrl = new Map(articleEvidence.map((item) => [item.url, item]));
    const selectedDecisions = triageDecisions.filter(
      (decision) => decision.bucket !== "ignore" && evidenceByUrl.has(decision.url),
    );

    filteredAdverseEvidence = sortByDate(dedupeEvidence(
      selectedDecisions
        .filter((decision) => decision.bucket === "adverse")
        .map((decision) => evidenceByUrl.get(decision.url))
        .filter(Boolean) as MediaEvidence[],
    ));
    filteredPositiveEvidence = sortByDate(dedupeEvidence(
      selectedDecisions
        .filter((decision) => decision.bucket === "positive")
        .map((decision) => evidenceByUrl.get(decision.url))
        .filter(Boolean) as MediaEvidence[],
    ));

    adverseMedia = sortByDate(
      selectedDecisions
      .filter((decision) => decision.bucket === "adverse")
      .map((decision) =>
        evidenceToFinding(
          evidenceByUrl.get(decision.url) as MediaEvidence,
          decision.risk_category || "adverse_media",
          decision.severity,
        ),
      )
      .slice(0, 6),
    ).slice(0, 6);
    positiveMedia = sortByDate(
      selectedDecisions
      .filter((decision) => decision.bucket === "positive")
      .map((decision) =>
        evidenceToFinding(
          evidenceByUrl.get(decision.url) as MediaEvidence,
          decision.risk_category || "positive_media",
          decision.severity,
        ),
      )
      .slice(0, 4),
    ).slice(0, 4);
  } else {
    filteredAdverseEvidence = sortByDate(dedupeEvidence(
      filterAdverseEvidence([
        ...adverseCandidates,
        ...reputationalCandidates,
        ...generalCandidates,
        ...recentCandidates,
      ]),
    ));
    filteredPositiveEvidence = sortByDate(dedupeEvidence(filterPositiveEvidence([
      ...positiveCandidates,
      ...generalCandidates,
      ...recentCandidates,
    ])));

    adverseMedia = findingsFromEvidence(filteredAdverseEvidence, "adverse_media", "medium")
      .sort((left, right) => dateRank(right.date) - dateRank(left.date));
    positiveMedia = findingsFromEvidence(filteredPositiveEvidence, "positive_media", "low")
      .sort((left, right) => dateRank(right.date) - dateRank(left.date));
  }

  return {
    adverseMedia,
    positiveMedia,
    adverseEvidence: filteredAdverseEvidence,
    positiveEvidence: filteredPositiveEvidence,
    sources: [...filteredAdverseEvidence, ...filteredPositiveEvidence].map(evidenceToSource),
    alternativeSources,
    alternativeDataSummary,
    triageMode: triageDecisions?.length ? "llm" : "heuristic",
  };
}

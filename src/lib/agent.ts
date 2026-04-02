import OpenAI from "openai";

import { env, hasOpenAiConfig } from "@/lib/env";
import { REPORT_ANSWER_PROMPT, REPORT_REQUEST_EXTRACTION_PROMPT } from "@/lib/prompts";
import { fetchIndividualFromCompaniesHouse } from "@/lib/providers/companies-house";
import { getReportStatus } from "@/lib/report-store";
import { withTimeout } from "@/lib/timeout";
import type {
  AgentRequest,
  AgentResponse,
  Citation,
  Report,
  ReportJob,
  ReportRequest,
} from "@/lib/types";

const openai = new OpenAI({
  apiKey: env.openAiApiKey,
});

function normaliseWhitespace(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function inferSubjectType(message: string): ReportRequest["subject_type"] {
  const lower = message.toLowerCase();

  if (
    /\b(ltd|limited|llp|plc|inc|corp|corporation|company|holdings|ventures|group)\b/.test(lower)
  ) {
    return "organisation";
  }

  return "individual";
}

function extractJurisdiction(message: string) {
  const lower = message.toLowerCase();

  if (lower.includes("united kingdom") || /\buk\b/.test(lower) || /\bgb\b/.test(lower)) {
    return "gb";
  }

  if (lower.includes("united states") || /\bus\b/.test(lower)) {
    return "us";
  }

  if (lower.includes("ireland")) {
    return "ie";
  }

  if (lower.includes("singapore")) {
    return "sg";
  }

  if (lower.includes("hong kong")) {
    return "hk";
  }

  if (lower.includes("switzerland")) {
    return "ch";
  }

  if (lower.includes("jersey")) {
    return "je";
  }

  if (lower.includes("guernsey")) {
    return "gg";
  }

  if (
    lower.includes("uae") ||
    lower.includes("united arab emirates") ||
    lower.includes("dubai") ||
    lower.includes("abu dhabi")
  ) {
    return "ae";
  }

  return undefined;
}

function extractDateOfBirth(message: string) {
  const exact = message.match(/\b(19|20)\d{2}-(0[1-9]|1[0-2])(-([0-2]\d|3[01]))?\b/);
  if (exact) {
    return exact[0];
  }

  const year = message.match(/\b(19|20)\d{2}\b/);
  return year?.[0];
}

function extractCompanyNumber(message: string) {
  const match = message.match(/\b(company number|company no\.?|number)\s*[:#]?\s*([A-Z0-9]{6,12})\b/i);
  return match?.[2];
}

function extractSubjectNameHeuristically(message: string, subjectType: ReportRequest["subject_type"]) {
  const cleaned = message
    .replace(/\b(screen|check|run|generate|create|research|diligence|report|on|for|please|do)\b/gi, " ")
    .replace(/\b(company number|company no\.?|dob|date of birth)\b.*$/i, " ")
    .replace(/[.,]/g, " ");
  const compact = normaliseWhitespace(cleaned);

  if (!compact) {
    return "";
  }

  if (subjectType === "organisation") {
    const orgMatch = compact.match(
      /\b([A-Z][A-Za-z0-9&' -]*(?:Ltd|Limited|LLP|PLC|Inc|Corp|Corporation|Group|Holdings|Ventures))\b/,
    );
    if (orgMatch) {
      return normaliseWhitespace(orgMatch[1]);
    }
  }

  const personMatch = compact.match(/\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})\b/);
  if (personMatch) {
    return normaliseWhitespace(personMatch[1]);
  }

  return compact.split(" ").slice(0, 6).join(" ");
}

async function extractReportRequestWithAi(message: string): Promise<ReportRequest | null> {
  if (!hasOpenAiConfig()) {
    return null;
  }

  const response = await withTimeout(
    openai.responses.create({
      model: env.openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: REPORT_REQUEST_EXTRACTION_PROMPT,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: message,
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "report_request_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              subject_name: { type: "string" },
              subject_type: { type: "string", enum: ["individual", "organisation"] },
              jurisdiction: {
                type: ["string", "null"],
                enum: ["gb", "us", "ie", "ae", "sg", "hk", "ch", "je", "gg", null],
              },
              company_number: { type: ["string", "null"] },
              date_of_birth: { type: ["string", "null"] },
              additional_context: { type: ["string", "null"] },
            },
            required: [
              "subject_name",
              "subject_type",
              "jurisdiction",
              "company_number",
              "date_of_birth",
              "additional_context",
            ],
          },
        },
      },
    }),
    15000,
    "Agent report extraction",
  );

  if (!response.output_text) {
    return null;
  }

  const parsed = JSON.parse(response.output_text) as {
    subject_name: string;
    subject_type: "individual" | "organisation";
    jurisdiction: string | null;
    company_number: string | null;
    date_of_birth: string | null;
    additional_context: string | null;
  };

  return {
    subject_name: parsed.subject_name.trim(),
    subject_type: parsed.subject_type,
    jurisdiction: parsed.jurisdiction || undefined,
    company_number: parsed.company_number || undefined,
    date_of_birth: parsed.date_of_birth || undefined,
    additional_context: parsed.additional_context || undefined,
  };
}

export async function extractReportRequest(message: string): Promise<ReportRequest | null> {
  const aiExtraction = await extractReportRequestWithAi(message).catch(() => null);
  if (aiExtraction?.subject_name) {
    return aiExtraction;
  }

  const subjectType = inferSubjectType(message);
  const subjectName = extractSubjectNameHeuristically(message, subjectType);

  if (!subjectName) {
    return null;
  }

  const additionalContext = normaliseWhitespace(
    message.replace(subjectName, "").replace(/\s+/g, " "),
  );

  return {
    subject_name: subjectName,
    subject_type: subjectType,
    jurisdiction: extractJurisdiction(message),
    company_number: extractCompanyNumber(message),
    date_of_birth: subjectType === "individual" ? extractDateOfBirth(message) : undefined,
    additional_context:
      additionalContext && additionalContext.length > 12 ? additionalContext : undefined,
  };
}

function buildFallbackAnswer(report: Report, question: string) {
  const topAdverse = report.adverse_media[0];
  const topSanctions = report.sanctions_screening.matches.find((match) => match.status !== "clear");
  const citations: Citation[] = [
    ...(report.executive_summary.citations || []),
    ...report.sources.slice(0, 2).map((source) => ({ url: source.url, title: source.title })),
  ].filter(
    (citation, index, all) => all.findIndex((entry) => entry.url === citation.url) === index,
  );

  const parts = [
    `For ${report.subject_name}, the current overall risk is ${report.executive_summary.overall_risk}.`,
    report.executive_summary.text,
    topSanctions
      ? `The most material screening signal is ${topSanctions.dataset}: ${topSanctions.detail}`
      : "No non-clear sanctions or PEP match is surfaced in the current report.",
    topAdverse
      ? `The top public-source finding is ${topAdverse.source_title}: ${topAdverse.summary}`
      : "No adverse media finding is currently surfaced.",
    `Question asked: ${question}`,
  ];

  return {
    message: parts.join(" "),
    citations: citations.slice(0, 4),
  };
}

async function answerReportWithAi(report: Report, question: string) {
  if (!hasOpenAiConfig()) {
    return buildFallbackAnswer(report, question);
  }

  const response = await withTimeout(
    openai.responses.create({
      model: env.openAiModel,
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: REPORT_ANSWER_PROMPT,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify({
                question,
                report,
              }),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "report_answer",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              message: { type: "string" },
              citations: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  properties: {
                    url: { type: "string" },
                    title: { type: "string" },
                  },
                  required: ["url", "title"],
                },
              },
            },
            required: ["message", "citations"],
          },
        },
      },
    }),
    15000,
    "Agent report answer",
  );

  if (!response.output_text) {
    return buildFallbackAnswer(report, question);
  }

  return JSON.parse(response.output_text) as {
    message: string;
    citations: Citation[];
  };
}

export async function handleAgentRequest(
  input: AgentRequest,
  createReportJob: (request: ReportRequest) => Promise<ReportJob>,
): Promise<AgentResponse> {
  const message = normaliseWhitespace(input.message);

  if (!message) {
    return {
      action: "clarify",
      message:
        "Tell me who you want to screen, with any helpful context such as jurisdiction, date of birth, or company number.",
    };
  }

  if (input.report_id) {
    const status = getReportStatus(input.report_id);

    if (!status) {
      return {
        action: "clarify",
        message: `I could not find report ${input.report_id}. Start a new diligence request or pass a valid report_id.`,
      };
    }

    if (status.status !== "complete" || !status.report) {
      return {
        action: "report_status",
        message:
          status.status === "failed"
            ? "This diligence run did not complete successfully."
            : "The diligence run is still in progress. I'll use the completed report once it's ready.",
        report_status: status,
      };
    }

    const answer = await answerReportWithAi(status.report, message).catch(() =>
      buildFallbackAnswer(status.report as Report, message),
    );

    return {
      action: "answer_report",
      message: answer.message,
      report_status: status,
      citations: answer.citations,
    };
  }

  const reportRequest = await extractReportRequest(message);

  if (!reportRequest?.subject_name) {
    return {
      action: "clarify",
      message:
        "I couldn't confidently identify the subject to screen. Include a person or company name, and optionally a date of birth, jurisdiction, or company number.",
    };
  }

  let resolvedSubjectName: string | undefined;
  let resolutionConfidence: "weak" | "moderate" | "strong" | undefined;

  if (reportRequest.subject_type === "individual") {
    const resolved = await fetchIndividualFromCompaniesHouse(reportRequest).catch(() => null);
    if (resolved?.subjectName) {
      resolvedSubjectName = resolved.subjectName;
      resolutionConfidence = resolved.matchConfidence;
    }
  }

  if (
    resolvedSubjectName &&
    resolvedSubjectName.toLowerCase() !== reportRequest.subject_name.toLowerCase() &&
    resolutionConfidence === "moderate"
  ) {
    return {
      action: "clarify",
      message: `I found a likely match: ${resolvedSubjectName} (moderate confidence). Reply "yes" to continue with that subject, or send a clearer name or more context instead.`,
      report_request: {
        ...reportRequest,
        subject_name: resolvedSubjectName,
      },
      resolved_subject_name: resolvedSubjectName,
      resolution_confidence: resolutionConfidence,
      confirmation_required: true,
    };
  }

  const reportJob = await createReportJob(reportRequest);

  return {
    action: "create_report",
    message:
      resolvedSubjectName &&
      resolvedSubjectName.toLowerCase() !== reportRequest.subject_name.toLowerCase()
        ? `I've started a ${reportRequest.subject_type} diligence run. I resolved the subject to ${resolvedSubjectName}${resolutionConfidence ? ` (${resolutionConfidence} confidence)` : ""}. You can stay in this chat and ask follow-up questions once the report is ready.`
        : `I've started a ${reportRequest.subject_type} diligence run for ${reportRequest.subject_name}. You can stay in this chat and ask follow-up questions once the report is ready.`,
    report_request: reportRequest,
    report_job: reportJob,
    resolved_subject_name: resolvedSubjectName,
    resolution_confidence: resolutionConfidence,
  };
}

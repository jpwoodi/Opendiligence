import OpenAI from "openai";

import { env } from "@/lib/env";
import { REPORT_SYNTHESIS_PROMPT } from "@/lib/prompts";
import type { MediaEvidence } from "@/lib/providers/brave-search";
import { withTimeout } from "@/lib/timeout";
import type {
  Association,
  MediaFinding,
  ReportRequest,
  RiskAssessment,
  RiskLevel,
  SanctionsMatch,
} from "@/lib/types";

const openai = new OpenAI({
  apiKey: env.openAiApiKey,
});

type SynthesizedReport = {
  executive_summary: {
    text: string;
    overall_risk: RiskLevel;
  };
  adverse_media: MediaFinding[];
  positive_media: MediaFinding[];
  associations: Association[];
  risk_assessment: RiskAssessment;
};

function fallbackSummary(
  name: string,
  subjectType: ReportRequest["subject_type"],
  sanctionsMatches?: SanctionsMatch[],
): SynthesizedReport["executive_summary"] {
  const topPepOffice = sanctionsMatches
    ?.find((match) => match.office_summary && match.status !== "clear")
    ?.office_summary;

  if (topPepOffice) {
    return {
      text:
        subjectType === "organisation"
          ? `${name} was reviewed using live corporate registry, search, and sanctions data. Screening indicates a politically exposed person or office-holder connection associated with: ${topPepOffice}. The report contains useful diligence signals, but it should still be treated as a prototype output pending claim verification and analyst review.`
          : `${name} was reviewed using live public-source and sanctions data. Screening indicates office-holder or PEP data associated with: ${topPepOffice}. The report contains useful diligence signals, but it should still be treated as a prototype output pending claim verification and analyst review.`,
      overall_risk: "amber",
    };
  }

  return {
    text:
      subjectType === "organisation"
        ? `${name} was reviewed using live corporate registry, search, and sanctions data. The report contains useful diligence signals, but it should still be treated as a prototype output pending claim verification and analyst review.`
        : `${name} was reviewed using live public-source and sanctions data. The report contains useful diligence signals, but it should still be treated as a prototype output pending claim verification and analyst review.`,
    overall_risk: "amber",
  };
}

function buildSchema() {
  return {
    name: "due_diligence_synthesis",
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        executive_summary: {
          type: "object",
          additionalProperties: false,
          properties: {
            text: { type: "string" },
            overall_risk: { type: "string", enum: ["green", "amber", "red"] },
          },
          required: ["text", "overall_risk"],
        },
        adverse_media: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              risk_category: { type: "string" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              source_url: { type: "string" },
              source_title: { type: "string" },
              date: { type: "string" },
            },
            required: ["summary", "risk_category", "severity", "source_url", "source_title", "date"],
          },
        },
        positive_media: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              summary: { type: "string" },
              risk_category: { type: "string" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              source_url: { type: "string" },
              source_title: { type: "string" },
              date: { type: "string" },
            },
            required: ["summary", "risk_category", "severity", "source_url", "source_title", "date"],
          },
        },
        associations: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              subject: { type: "string" },
              relationship: { type: "string" },
              detail: { type: "string" },
              source_url: { type: "string" },
            },
            required: ["subject", "relationship", "detail", "source_url"],
          },
        },
        risk_assessment: {
          type: "object",
          additionalProperties: false,
          properties: {
            financial_crime: { type: "string", enum: ["green", "amber", "red"] },
            regulatory: { type: "string", enum: ["green", "amber", "red"] },
            esg: { type: "string", enum: ["green", "amber", "red"] },
            reputational: { type: "string", enum: ["green", "amber", "red"] },
            sanctions: { type: "string", enum: ["green", "amber", "red"] },
            insolvency: { type: "string", enum: ["green", "amber", "red"] },
          },
          required: [
            "financial_crime",
            "regulatory",
            "esg",
            "reputational",
            "sanctions",
            "insolvency",
          ],
        },
      },
      required: [
        "executive_summary",
        "adverse_media",
        "positive_media",
        "associations",
        "risk_assessment",
      ],
    },
    strict: true,
  } as const;
}

export async function synthesizeReportWithOpenAi(input: {
  request: ReportRequest;
  subjectName: string;
  corporateProfile?: unknown;
  subjectProfile?: unknown;
  officers: unknown[];
  pscs: unknown[];
  sanctionsMatches: SanctionsMatch[];
  adverseMedia: MediaFinding[];
  positiveMedia: MediaFinding[];
  adverseEvidence?: MediaEvidence[];
  positiveEvidence?: MediaEvidence[];
  associations: Association[];
}): Promise<SynthesizedReport> {
  if (!env.openAiApiKey) {
    throw new Error("OPENAI_API_KEY is not configured.");
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
              text: REPORT_SYNTHESIS_PROMPT,
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: JSON.stringify(input),
            },
          ],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          ...buildSchema(),
        },
      },
    }),
    40000,
    "OpenAI synthesis",
  );

  const jsonText = response.output_text;
  if (!jsonText) {
    throw new Error("OpenAI synthesis returned no structured output.");
  }

  return JSON.parse(jsonText) as SynthesizedReport;
}

export function buildSynthesisFallback(input: {
  request: ReportRequest;
  subjectName: string;
  sanctionsMatches?: SanctionsMatch[];
  adverseMedia: MediaFinding[];
  positiveMedia: MediaFinding[];
  associations: Association[];
  riskAssessment: RiskAssessment;
}): SynthesizedReport {
  return {
    executive_summary: fallbackSummary(
      input.subjectName,
      input.request.subject_type,
      input.sanctionsMatches,
    ),
    adverse_media: input.adverseMedia,
    positive_media: input.positiveMedia,
    associations: input.associations,
    risk_assessment: input.riskAssessment,
  };
}

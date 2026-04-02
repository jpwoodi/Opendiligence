import {
  MEDIA_TRIAGE_PROMPT,
  REPORT_ANSWER_PROMPT,
  REPORT_REQUEST_EXTRACTION_PROMPT,
  REPORT_SYNTHESIS_PROMPT,
} from "@/lib/prompts";

export interface PromptRegressionCase {
  id: string;
  prompt: "media_triage" | "report_synthesis" | "request_extraction" | "report_answer";
  scenario: string;
  expectedPhrases: string[];
}

export const PROMPT_REGRESSION_CASES: PromptRegressionCase[] = [
  {
    id: "media-ignores-speaker-bio",
    prompt: "media_triage",
    scenario:
      "A Milken Institute Asia Summit speaker page mentions a prominent person and reads like a bio rather than a reported article.",
    expectedPhrases: ["speaker bios", "not actually news", "recent reported events", "ambiguous"],
  },
  {
    id: "media-requires-target-confidence",
    prompt: "media_triage",
    scenario:
      "A common-name article mentions the same surname but offers weak evidence that it is the correct target.",
    expectedPhrases: ["common names", "target", "ignore"],
  },
  {
    id: "request-extraction-follow-up",
    prompt: "request_extraction",
    scenario:
      "The user asks 'what are the main risk drivers?' which is a follow-up question rather than a new screening request.",
    expectedPhrases: ["follow-up", "subject_name empty", "optional fields empty"],
  },
  {
    id: "request-extraction-no-guessing",
    prompt: "request_extraction",
    scenario:
      "The user provides a partial company name and some vague geography but no company number or DOB.",
    expectedPhrases: ["Do not invent", "optional fields", "guessing"],
  },
  {
    id: "synthesis-handles-weak-evidence",
    prompt: "report_synthesis",
    scenario:
      "Only one weak media article supports a potentially negative claim.",
    expectedPhrases: ["weak", "Do not overstate", "insufficient"],
  },
  {
    id: "synthesis-separates-fact-from-analysis",
    prompt: "report_synthesis",
    scenario:
      "The output should distinguish what sources say from the analyst's interpretation.",
    expectedPhrases: ["supported facts", "analytical interpretation"],
  },
  {
    id: "answer-leads-directly",
    prompt: "report_answer",
    scenario:
      "The user asks whether the report shows sanctions exposure.",
    expectedPhrases: ["Lead with the direct answer", "uncertainty", "speculation"],
  },
];

export function promptTextForCase(caseId: PromptRegressionCase["id"]) {
  const regressionCase = PROMPT_REGRESSION_CASES.find((item) => item.id === caseId);

  if (!regressionCase) {
    throw new Error(`Unknown prompt regression case: ${caseId}`);
  }

  return getPromptText(regressionCase.prompt);
}

export function getPromptText(
  prompt: PromptRegressionCase["prompt"],
) {
  switch (prompt) {
    case "media_triage":
      return MEDIA_TRIAGE_PROMPT;
    case "report_synthesis":
      return REPORT_SYNTHESIS_PROMPT;
    case "request_extraction":
      return REPORT_REQUEST_EXTRACTION_PROMPT;
    case "report_answer":
      return REPORT_ANSWER_PROMPT;
  }
}

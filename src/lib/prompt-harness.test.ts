import { describe, expect, it } from "vitest";

import {
  PROMPT_REGRESSION_CASES,
  getPromptText,
} from "@/lib/prompt-harness";

describe("prompt regression harness", () => {
  it("covers the expected prompt surfaces", () => {
    expect(
      new Set(PROMPT_REGRESSION_CASES.map((item) => item.prompt)),
    ).toEqual(
      new Set([
        "media_triage",
        "report_synthesis",
        "request_extraction",
        "report_answer",
      ]),
    );
  });

  for (const regressionCase of PROMPT_REGRESSION_CASES) {
    it(`locks prompt guidance for ${regressionCase.id}`, () => {
      const prompt = getPromptText(regressionCase.prompt).toLowerCase();

      for (const phrase of regressionCase.expectedPhrases) {
        expect(prompt).toContain(phrase.toLowerCase());
      }
    });
  }
});

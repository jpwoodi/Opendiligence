import { describe, expect, it } from "vitest";

import type { MediaFinding } from "@/lib/types";
import { filterEvidenceForIndividual, verifyMediaFindings } from "@/lib/providers/media-verification";

describe("media verification", () => {
  it("filters out unrelated individual evidence", () => {
    const evidence = [
      {
        url: "https://example.com/a",
        title: "Thomas Hoegh joins growth company board",
        snippet: "Thomas Hoegh joined the board of Growth Street in London.",
        extracted_text: "Thomas Hoegh joined the board of Growth Street in London.",
        date: "2026-01-11",
        content_type: "text/html",
      },
      {
        url: "https://example.com/b",
        title: "Another Hoegh executive discussed shipping markets",
        snippet: "A separate Hoegh family executive discussed shipping markets in Oslo.",
        extracted_text: "A separate Hoegh family executive discussed shipping markets in Oslo.",
        date: "2026-01-12",
        content_type: "text/html",
      },
    ];

    const filtered = filterEvidenceForIndividual({
      requestName: "Thomas Hoegh",
      canonicalName: "Thomas Christian Hoegh",
      evidence,
      referenceTerms: ["Growth Street", "London"],
    });

    expect(filtered).toHaveLength(1);
    expect(filtered[0]?.url).toBe("https://example.com/a");
  });

  it("falls back to source text when a finding is not well supported", () => {
    const findings: MediaFinding[] = [
      {
        summary: "Unrelated allegation that is not supported by the source text.",
        risk_category: "regulatory",
        severity: "high",
        source_url: "https://example.com/a",
        source_title: "Example source",
        date: "2026-01-12",
      },
    ];

    const verified = verifyMediaFindings(findings, [
      {
        url: "https://example.com/a",
        title: "Example source",
        snippet:
          "Thomas Hoegh was quoted discussing board governance improvements and compliance controls.",
        extracted_text:
          "Thomas Hoegh was quoted discussing board governance improvements and compliance controls in an interview.",
        date: "2026-01-12",
        content_type: "text/html",
      },
    ]);

    expect(verified[0]?.verification_status).toBe("fallback");
    expect(verified[0]?.severity).toBe("medium");
    expect(verified[0]?.summary).toContain("Thomas Hoegh");
  });
});

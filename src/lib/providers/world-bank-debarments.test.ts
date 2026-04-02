import { describe, expect, it } from "vitest";

import { scoreWorldBankDebarmentRecord } from "@/lib/providers/world-bank-debarments";

describe("world bank debarments matching", () => {
  it("prefers exact firm matches over looser partial overlaps", () => {
    const request = {
      subject_name: "Acme Holdings Ltd",
      subject_type: "organisation" as const,
      jurisdiction: "gb",
    };

    const exact = scoreWorldBankDebarmentRecord(
      {
        firm_name: "Acme Holdings Ltd",
        country: "United Kingdom",
      },
      request,
    );
    const loose = scoreWorldBankDebarmentRecord(
      {
        firm_name: "Acme Trading",
        country: "Kenya",
      },
      request,
    );

    expect(exact).toBeGreaterThan(loose);
    expect(exact).toBeGreaterThanOrEqual(0.85);
  });
});

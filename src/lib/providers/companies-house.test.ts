import { describe, expect, it } from "vitest";

import {
  determineConfidence,
  downgradeConfidence,
  samePersonCandidate,
  scoreOfficerCandidate,
} from "@/lib/providers/companies-house";

describe("companies house matching", () => {
  it("scores an exact name and dob match above a weaker candidate", () => {
    const request = {
      subject_name: "Rishi Sunak",
      subject_type: "individual" as const,
      date_of_birth: "1980-05-12",
    };

    const strongScore = scoreOfficerCandidate(
      {
        title: "Rishi Sunak",
        appointment_count: 6,
        date_of_birth: { year: 1980, month: 5 },
      },
      request,
    );
    const weakScore = scoreOfficerCandidate(
      {
        title: "R Sunak",
        appointment_count: 1,
      },
      request,
    );

    expect(strongScore).toBeGreaterThan(weakScore);
    expect(determineConfidence(strongScore)).toBe("strong");
  });

  it("downgrades strong confidence when ambiguity needs caution", () => {
    expect(downgradeConfidence("strong")).toBe("moderate");
    expect(downgradeConfidence("moderate")).toBe("weak");
  });

  it("uses year-only birth hints for scoring", () => {
    const request = {
      subject_name: "Chetan Chhatwal",
      subject_type: "individual" as const,
      date_of_birth: "1980",
    };

    const score = scoreOfficerCandidate(
      {
        title: "Chetan Chhatwal",
        appointment_count: 3,
        date_of_birth: { year: 1980, month: 7 },
      },
      request,
    );

    expect(score).toBeGreaterThan(10);
  });

  it("treats same-name candidates with matching birth year as mergeable", () => {
    const request = {
      subject_name: "Chetan Chhatwal",
      subject_type: "individual" as const,
      date_of_birth: "1978",
    };

    expect(
      samePersonCandidate(
        {
          title: "Chetan Chhatwal",
          links: { self: "/officers/1/appointments" },
          date_of_birth: { year: 1978, month: 3 },
        },
        {
          title: "Chetan Chhatwal",
          links: { self: "/officers/2/appointments" },
          date_of_birth: { year: 1978 },
        },
        request,
      ),
    ).toBe(true);

    expect(
      samePersonCandidate(
        {
          title: "Chetan Chhatwal",
          links: { self: "/officers/3/appointments" },
          date_of_birth: { year: 1984, month: 3 },
        },
        {
          title: "Chetan Chhatwal",
          links: { self: "/officers/2/appointments" },
          date_of_birth: { year: 1978 },
        },
        request,
      ),
    ).toBe(false);
  });
});

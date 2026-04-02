import { describe, expect, it } from "vitest";

import { looksLikeNonArticle } from "@/lib/providers/brave-search";

describe("brave search media filtering", () => {
  it("rejects profile and directory pages as media articles", () => {
    expect(
      looksLikeNonArticle({
        url: "https://www.crunchbase.com/person/thomas-hoegh",
        title: "Thomas Hoegh - Founder @ Growth Street - Crunchbase Person Profile",
        snippet: "Thomas is the founder of Arts Alliance...",
        extracted_text: "Thomas is the founder of Arts Alliance...",
        date: "2026-04-01",
        content_type: "text/html",
      }),
    ).toBe(true);
  });

  it("keeps article-like news pages eligible", () => {
    expect(
      looksLikeNonArticle({
        url: "https://www.ft.com/content/example-story",
        title: "Growth Street founder discusses fintech regulation",
        snippet: "The founder said the company would expand after the latest funding round.",
        extracted_text: "The founder said the company would expand after the latest funding round.",
        date: "2026-04-01",
        content_type: "text/html",
      }),
    ).toBe(false);
  });

  it("rejects event speaker and summit bio pages as non-news", () => {
    expect(
      looksLikeNonArticle({
        url: "https://milkeninstitute.org/events/asia-summit/speakers/lord-mandelson",
        title: "Lord Mandelson | Milken Institute",
        snippet: "Peter Mandelson is co-founder and chairman of Global Counsel and a former European Trade Commissioner.",
        extracted_text:
          "Peter Mandelson is co-founder and chairman of Global Counsel. He is a former European Trade Commissioner and British First Secretary of State. Asia Summit speaker profile.",
        date: "2019-09-18",
        content_type: "text/html",
      }),
    ).toBe(true);
  });

  it("keeps social and alternative domains out of core news classification", () => {
    expect(
      looksLikeNonArticle({
        url: "https://x.com/example/status/123",
        title: "Breaking update on corporate matter",
        snippet: "Thread discussing a reported development.",
        extracted_text: "Thread discussing a reported development on X.",
        date: "2026-04-01",
        content_type: "text/html",
      }),
    ).toBe(false);
  });
});

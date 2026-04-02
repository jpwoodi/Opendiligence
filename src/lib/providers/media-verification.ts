import type { MatchConfidence, MediaFinding } from "@/lib/types";
import type { MediaEvidence } from "@/lib/providers/brave-search";

const STOPWORDS = new Set([
  "about",
  "after",
  "against",
  "among",
  "been",
  "being",
  "from",
  "into",
  "more",
  "than",
  "that",
  "their",
  "there",
  "these",
  "they",
  "this",
  "with",
  "were",
  "which",
  "while",
  "would",
  "under",
  "over",
  "when",
  "what",
  "where",
]);

function normalise(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9\s]/g, " ");
}

function keywords(value: string) {
  return normalise(value)
    .split(/\s+/)
    .filter((token) => token.length > 3 && !STOPWORDS.has(token));
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

function verifiedAgainstEvidence(summary: string, evidence: MediaEvidence) {
  const haystack = `${evidence.snippet} ${evidence.extracted_text}`.toLowerCase();
  const summaryKeywords = keywords(summary);

  if (!summaryKeywords.length) {
    return false;
  }

  const matched = summaryKeywords.filter((token) => haystack.includes(token));
  return matched.length >= Math.min(4, Math.max(2, Math.ceil(summaryKeywords.length * 0.35)));
}

function fallbackSummary(evidence: MediaEvidence) {
  const sourceText = evidence.extracted_text || evidence.snippet;
  const sentence = sourceText
    .split(/(?<=[.!?])\s+/)
    .find((part) => part.trim().length > 80);

  return sentence?.trim() || evidence.snippet;
}

function buildEvidenceSpans(summary: string, evidence: MediaEvidence) {
  const sourceText = normalise(`${evidence.snippet} ${evidence.extracted_text}`);
  const sourceSentences = sourceText
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 40);
  const summaryKeywords = unique(keywords(summary));

  return sourceSentences
    .map((sentence) => ({
      sentence,
      score: summaryKeywords.filter((token) => sentence.includes(token)).length,
    }))
    .filter((candidate) => candidate.score >= 2)
    .sort((left, right) => right.score - left.score)
    .slice(0, 2)
    .map((candidate) => candidate.sentence.slice(0, 180));
}

export function filterEvidenceForIndividual(input: {
  requestName: string;
  canonicalName: string;
  evidence: MediaEvidence[];
  referenceTerms: string[];
}) {
  const aliases = unique([input.requestName, input.canonicalName]).filter(Boolean);
  const requestTokens = keywords(input.requestName);
  const firstName = requestTokens[0];
  const surname = requestTokens[requestTokens.length - 1];
  const anchors = unique(
    input.referenceTerms.flatMap((term) => keywords(term)).filter((token) => token.length > 4),
  ).slice(0, 12);

  return input.evidence.filter((item) => {
    const haystack = normalise(`${item.title} ${item.snippet} ${item.extracted_text}`);
    let score = 0;

    if (aliases.some((alias) => keywords(alias).every((token) => haystack.includes(token)))) {
      score += 6;
    }

    if (surname && haystack.includes(surname)) {
      score += 3;
    } else {
      score -= 6;
    }

    if (firstName && haystack.includes(firstName)) {
      score += 1;
    }

    score += Math.min(4, anchors.filter((token) => haystack.includes(token)).length);

    return score >= 6;
  });
}

function assessEvidenceForIndividual(input: {
  requestName: string;
  canonicalName: string;
  evidence: MediaEvidence;
  referenceTerms: string[];
}) {
  const aliases = unique([input.requestName, input.canonicalName]).filter(Boolean);
  const requestTokens = keywords(input.requestName);
  const firstName = requestTokens[0];
  const surname = requestTokens[requestTokens.length - 1];
  const anchors = unique(
    input.referenceTerms.flatMap((term) => keywords(term)).filter((token) => token.length > 4),
  ).slice(0, 12);
  const haystack = normalise(
    `${input.evidence.title} ${input.evidence.snippet} ${input.evidence.extracted_text}`,
  );
  let score = 0;
  const reasons: string[] = [];

  if (aliases.some((alias) => keywords(alias).every((token) => haystack.includes(token)))) {
    score += 6;
    reasons.push("full-name mention");
  }

  if (surname && haystack.includes(surname)) {
    score += 3;
    reasons.push("surname present");
  } else {
    score -= 6;
  }

  if (firstName && haystack.includes(firstName)) {
    score += 1;
    reasons.push("first name present");
  }

  const matchedAnchors = anchors.filter((token) => haystack.includes(token));
  score += Math.min(4, matchedAnchors.length);
  if (matchedAnchors.length) {
    reasons.push(`context anchors: ${matchedAnchors.slice(0, 3).join(", ")}`);
  }

  return {
    score,
    reason: reasons.length ? reasons.join("; ") : "name-based media match",
    confidence: score >= 9 ? ("strong" as MatchConfidence) : score >= 6 ? ("moderate" as MatchConfidence) : ("weak" as MatchConfidence),
  };
}

export function annotateMediaFindingsForIndividual(input: {
  requestName: string;
  canonicalName: string;
  findings: MediaFinding[];
  evidence: MediaEvidence[];
  referenceTerms: string[];
}) {
  const assessments = new Map(
    input.evidence.map((item) => [
      item.url,
      assessEvidenceForIndividual({
        requestName: input.requestName,
        canonicalName: input.canonicalName,
        evidence: item,
        referenceTerms: input.referenceTerms,
      }),
    ]),
  );

  return input.findings.map((finding) => {
    const assessment = assessments.get(finding.source_url);

    if (!assessment) {
      return finding;
    }

    return {
      ...finding,
      match_reason: finding.match_reason || assessment.reason,
      match_confidence: finding.match_confidence || assessment.confidence,
    };
  });
}

export function verifyMediaFindings(findings: MediaFinding[], evidence: MediaEvidence[]) {
  const evidenceByUrl = new Map(evidence.map((item) => [item.url, item]));

  return findings.map((finding) => {
    const sourceEvidence = evidenceByUrl.get(finding.source_url);

    if (!sourceEvidence) {
      return finding;
    }

    if (verifiedAgainstEvidence(finding.summary, sourceEvidence)) {
      return {
        ...finding,
        verification_status: "verified" as const,
        evidence_spans: buildEvidenceSpans(finding.summary, sourceEvidence),
      };
    }

    return {
      ...finding,
      summary: fallbackSummary(sourceEvidence),
      severity: finding.severity === "high" ? "medium" : finding.severity,
      risk_category: `${finding.risk_category}_verified_from_source`,
      verification_status: sourceEvidence.extracted_text ? "fallback" as const : "weak" as const,
      evidence_spans: buildEvidenceSpans(finding.summary, sourceEvidence),
    };
  });
}

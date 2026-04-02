import { existsSync, readFileSync } from "fs";
import { resolve } from "path";

import OpenAI from "openai";

import { EVAL_CASES, type EvalCase, type EvalSuiteName } from "../src/lib/evals/cases";
import {
  MEDIA_TRIAGE_PROMPT,
  REPORT_ANSWER_PROMPT,
  REPORT_REQUEST_EXTRACTION_PROMPT,
} from "../src/lib/prompts";

function loadEnvFile(filename: string) {
  const path = resolve(process.cwd(), filename);
  if (!existsSync(path)) {
    return;
  }

  const content = readFileSync(path, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim().replace(/^['"]|['"]$/g, "");

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnvFile(".env.local");
loadEnvFile(".env");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("OPENAI_API_KEY is required to run live evals.");
}

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const requestedSuite = process.argv
  .find((arg) => arg.startsWith("--suite="))
  ?.split("=")[1] as EvalSuiteName | undefined;

function formatResult(ok: boolean) {
  return ok ? "PASS" : "FAIL";
}

async function runRequestExtractionEval(testCase: Extract<EvalCase, { suite: "request_extraction" }>) {
  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: REPORT_REQUEST_EXTRACTION_PROMPT }],
      },
      {
        role: "user",
        content: [{ type: "input_text", text: testCase.input }],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "report_request_extraction_eval",
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
  });

  const output = JSON.parse(response.output_text || "{}") as Record<string, string | null>;
  const failures: string[] = [];

  if (testCase.expected.emptySubject) {
    if ((output.subject_name || "").trim() !== "") {
      failures.push(`expected empty subject_name, got "${output.subject_name}"`);
    }
  } else if ((output.subject_name || "").trim().toLowerCase() !== testCase.expected.subject_name.toLowerCase()) {
    failures.push(`expected subject_name "${testCase.expected.subject_name}", got "${output.subject_name}"`);
  }

  if (output.subject_type !== testCase.expected.subject_type) {
    failures.push(`expected subject_type "${testCase.expected.subject_type}", got "${output.subject_type}"`);
  }

  if (testCase.expected.jurisdiction && output.jurisdiction !== testCase.expected.jurisdiction) {
    failures.push(`expected jurisdiction "${testCase.expected.jurisdiction}", got "${output.jurisdiction}"`);
  }

  if (testCase.expected.company_number && output.company_number !== testCase.expected.company_number) {
    failures.push(`expected company_number "${testCase.expected.company_number}", got "${output.company_number}"`);
  }

  if (testCase.expected.date_of_birth && output.date_of_birth !== testCase.expected.date_of_birth) {
    failures.push(`expected date_of_birth "${testCase.expected.date_of_birth}", got "${output.date_of_birth}"`);
  }

  return {
    ok: failures.length === 0,
    failures,
    output,
  };
}

async function runMediaTriageEval(testCase: Extract<EvalCase, { suite: "media_triage" }>) {
  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: MEDIA_TRIAGE_PROMPT }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              request: testCase.request,
              evidence: testCase.evidence,
            }),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "media_triage_eval",
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
  });

  const output = JSON.parse(response.output_text || '{"decisions": []}') as {
    decisions: Array<{ url: string; bucket: "adverse" | "positive" | "ignore" }>;
  };
  const byUrl = new Map(output.decisions.map((decision) => [decision.url, decision.bucket]));
  const failures: string[] = [];

  for (const [url, expectedBucket] of Object.entries(testCase.expected)) {
    const actualBucket = byUrl.get(url);
    if (actualBucket !== expectedBucket) {
      failures.push(`expected ${url} -> ${expectedBucket}, got ${actualBucket || "missing"}`);
    }
  }

  return {
    ok: failures.length === 0,
    failures,
    output,
  };
}

async function runReportAnswerEval(testCase: Extract<EvalCase, { suite: "report_answer" }>) {
  const response = await client.responses.create({
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: REPORT_ANSWER_PROMPT }],
      },
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              question: testCase.question,
              report: testCase.report,
            }),
          },
        ],
      },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "report_answer_eval",
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
  });

  const output = JSON.parse(response.output_text || '{"message":"","citations":[]}') as {
    message: string;
    citations: Array<{ url: string; title: string }>;
  };
  const lowerMessage = output.message.toLowerCase();
  const failures: string[] = [];

  for (const phrase of testCase.expected.mustInclude) {
    if (!lowerMessage.includes(phrase.toLowerCase())) {
      failures.push(`missing required phrase "${phrase}"`);
    }
  }

  for (const phrase of testCase.expected.mustNotInclude || []) {
    if (lowerMessage.includes(phrase.toLowerCase())) {
      failures.push(`included forbidden phrase "${phrase}"`);
    }
  }

  if (
    typeof testCase.expected.minCitations === "number" &&
    output.citations.length < testCase.expected.minCitations
  ) {
    failures.push(`expected at least ${testCase.expected.minCitations} citations, got ${output.citations.length}`);
  }

  return {
    ok: failures.length === 0,
    failures,
    output,
  };
}

async function runEval(testCase: EvalCase) {
  switch (testCase.suite) {
    case "request_extraction":
      return runRequestExtractionEval(testCase);
    case "media_triage":
      return runMediaTriageEval(testCase);
    case "report_answer":
      return runReportAnswerEval(testCase);
  }
}

async function main() {
  const selectedCases = requestedSuite
    ? EVAL_CASES.filter((testCase) => testCase.suite === requestedSuite)
    : EVAL_CASES;

  if (!selectedCases.length) {
    throw new Error(`No eval cases found for suite ${requestedSuite}.`);
  }

  let failed = 0;

  for (const testCase of selectedCases) {
    const result = await runEval(testCase);
    console.log(`\n[${formatResult(result.ok)}] ${testCase.id} (${testCase.suite})`);

    if (result.ok) {
      console.log(JSON.stringify(result.output, null, 2));
      continue;
    }

    failed += 1;
    for (const failure of result.failures) {
      console.log(`  - ${failure}`);
    }
    console.log(JSON.stringify(result.output, null, 2));
  }

  console.log(`\nCompleted ${selectedCases.length} eval(s). Failures: ${failed}. Model: ${model}`);

  if (failed > 0) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

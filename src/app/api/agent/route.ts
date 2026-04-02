import { NextResponse } from "next/server";

import { guardApiRequest } from "@/lib/api-guard";
import { handleAgentRequest } from "@/lib/agent";
import { createReportJob } from "@/lib/report-store";
import type { AgentRequest } from "@/lib/types";

export async function POST(request: Request) {
  const guardResponse = guardApiRequest(request);
  if (guardResponse) {
    return guardResponse;
  }

  const body = (await request.json()) as AgentRequest;

  if (!body.message?.trim()) {
    return NextResponse.json(
      { error: "message is required" },
      { status: 400 },
    );
  }

  const response = await handleAgentRequest(body, createReportJob);
  return NextResponse.json(response);
}

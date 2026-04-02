import { NextResponse } from "next/server";

import { guardApiRequest } from "@/lib/api-guard";
import { createReportJob } from "@/lib/report-store";
import type { ReportRequest } from "@/lib/types";

export async function POST(request: Request) {
  const guardResponse = guardApiRequest(request);
  if (guardResponse) {
    return guardResponse;
  }

  const body = (await request.json()) as ReportRequest;

  if (!body.subject_name?.trim()) {
    return NextResponse.json(
      { error: "subject_name is required" },
      { status: 400 },
    );
  }

  if (body.subject_type !== "individual" && body.subject_type !== "organisation") {
    return NextResponse.json(
      { error: "subject_type must be individual or organisation" },
      { status: 400 },
    );
  }

  const job = await createReportJob(body);
  return NextResponse.json(job, { status: 202 });
}

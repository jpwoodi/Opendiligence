import { NextResponse } from "next/server";

import { guardApiRequest } from "@/lib/api-guard";
import { getReportStatus } from "@/lib/report-store";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const guardResponse = guardApiRequest(request);
  if (guardResponse) {
    return guardResponse;
  }

  const { id } = await context.params;
  const report = getReportStatus(id);

  if (!report) {
    return NextResponse.json({ error: "Report not found" }, { status: 404 });
  }

  return NextResponse.json(report);
}

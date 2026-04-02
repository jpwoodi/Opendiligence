import { NextResponse } from "next/server";

import { env } from "@/lib/env";

const WINDOW_MS = 60_000;

type Bucket = {
  count: number;
  resetAt: number;
};

declare global {
  var __openDiligenceRateLimitBuckets: Map<string, Bucket> | undefined;
}

const buckets = globalThis.__openDiligenceRateLimitBuckets ?? new Map<string, Bucket>();

if (!globalThis.__openDiligenceRateLimitBuckets) {
  globalThis.__openDiligenceRateLimitBuckets = buckets;
}

function clientIp(request: Request) {
  const forwarded = request.headers.get("x-forwarded-for");
  if (forwarded) {
    return forwarded.split(",")[0]?.trim() || "unknown";
  }

  return request.headers.get("x-real-ip") || "unknown";
}

function extractAccessKey(request: Request) {
  const headerKey = request.headers.get("x-opendiligence-key");
  if (headerKey) {
    return headerKey.trim();
  }

  const authHeader = request.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    return authHeader.slice("Bearer ".length).trim();
  }

  return undefined;
}

function rateLimitForMethod(method: string) {
  return method.toUpperCase() === "POST"
    ? env.rateLimitPostPerMinute
    : env.rateLimitGetPerMinute;
}

export function guardApiRequest(request: Request) {
  if (env.appAccessKey) {
    const candidate = extractAccessKey(request);
    if (candidate !== env.appAccessKey) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
  }

  const ip = clientIp(request);
  const now = Date.now();
  const key = `${request.method}:${ip}`;
  const limit = rateLimitForMethod(request.method);
  const bucket = buckets.get(key);

  if (!bucket || bucket.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return null;
  }

  if (bucket.count >= limit) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((bucket.resetAt - now) / 1000)),
        },
      },
    );
  }

  bucket.count += 1;
  return null;
}

import { v1 } from "@/lib/api/v1";
import { contentAudit, ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

function numberParam(url: URL, name: string, min: number, max: number): number | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) throw new ServiceError("invalid", `${name} must be a number from ${min} to ${max}.`);
  return value;
}

/** Stale, expired, thin and near-duplicate pages across the credential's site folders. */
export function GET(request: Request) {
  return v1(request, "v1-content-audit", 10, async (ctx) => {
    const url = new URL(request.url);
    return contentAudit(ctx, {
      staleDays: numberParam(url, "staleDays", 1, 3650),
      thinWords: numberParam(url, "thinWords", 1, 5000),
      duplicateThreshold: numberParam(url, "duplicateThreshold", 0.3, 1),
    });
  });
}

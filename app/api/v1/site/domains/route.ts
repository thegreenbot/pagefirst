import { domainActor, domainError } from "@/lib/api/site";
import { readJson, v1 } from "@/lib/api/v1";
import { addSiteDomain, listSiteDomains } from "@/lib/domains/service";
import { ServiceError } from "@/lib/service";

export const dynamic = "force-dynamic";

/** The site's custom domains and where each one stands. */
export function GET(request: Request) {
  return v1(request, "v1-domains-list", 120, async (ctx) => {
    try {
      return { domains: await listSiteDomains(await domainActor(ctx, "pages:read")) };
    } catch (error) {
      return domainError(error);
    }
  });
}

/** Adds a domain. The response lists the DNS records the owner still has to create. */
export function POST(request: Request) {
  return v1(
    request,
    "v1-domains-add",
    20,
    async (ctx) => {
      const actor = await domainActor(ctx, "pages:publish", true);
      const body = (await readJson(request, 4 * 1024)) as { hostname?: unknown };
      if (typeof body.hostname !== "string" || !body.hostname.trim()) throw new ServiceError("invalid", "hostname is required.");
      try {
        return await addSiteDomain(actor, body.hostname);
      } catch (error) {
        return domainError(error);
      }
    },
    { idempotent: true },
  );
}

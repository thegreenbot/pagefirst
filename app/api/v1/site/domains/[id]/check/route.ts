import { domainActor, domainError } from "@/lib/api/site";
import { v1 } from "@/lib/api/v1";
import { checkSiteDomain } from "@/lib/domains/service";

export const dynamic = "force-dynamic";

/** Asks where the domain stands and starts serving it once it is verified. Safe to repeat. */
export function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  return v1(request, "v1-domains-check", 60, async (ctx) => {
    const actor = await domainActor(ctx, "pages:publish", true);
    const { id } = await context.params;
    try {
      return await checkSiteDomain(actor, id);
    } catch (error) {
      return domainError(error);
    }
  });
}

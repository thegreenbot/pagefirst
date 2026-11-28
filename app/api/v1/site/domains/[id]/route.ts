import { domainActor, domainError } from "@/lib/api/site";
import { v1 } from "@/lib/api/v1";
import { removeSiteDomain } from "@/lib/domains/service";

export const dynamic = "force-dynamic";

/** Stops serving the domain and releases it. Serving stops first; DNS records at the owner's host are never touched. */
export function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  return v1(
    request,
    "v1-domains-remove",
    20,
    async (ctx) => {
      const actor = await domainActor(ctx, "pages:publish", true);
      const { id } = await context.params;
      try {
        await removeSiteDomain(actor, id);
        return { ok: true };
      } catch (error) {
        return domainError(error);
      }
    },
    { idempotent: true },
  );
}

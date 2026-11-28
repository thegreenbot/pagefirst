import { createHash } from "node:crypto";
import { recordAudit } from "@/lib/audit";
import { query } from "@/lib/db/client";
import { deleteHost, putHost } from "@/lib/publish/r2";
import { publishDomain } from "@/lib/publish/sites";
import { isApex, normalizeHostname, withinLimits, type DomainLimits } from "./hostname";
import { configuredDomainProvider } from "./index";
import type { DnsRecord, DomainProvider, ProviderStatus } from "./provider";
import { countDomains, createDomain, DomainError, getDomain, listDomainsByStatus, listDomains, removeDomain, setDomainStatus, type SiteDomain } from "./store";

/**
 * Adds, verifies, activates and removes a site's custom domains (#186).
 *
 * The rule that keeps domains safe: `hosts/<hostname>` in the bucket is written
 * only once the provider reports the hostname active, and it is deleted before
 * the provider record goes. A hostname that has not been verified never serves,
 * and one that stops validating stops serving.
 */

export class DomainServiceError extends Error {
  constructor(
    readonly code: "invalid" | "limit" | "taken" | "not_found" | "unavailable" | "provider",
    message: string,
  ) {
    super(message);
  }
}

export type HostStore = {
  put(hostname: string, siteId: string): Promise<void>;
  remove(hostname: string): Promise<void>;
};

export type DomainDeps = {
  provider: DomainProvider | null;
  hosts: HostStore;
  limits: DomainLimits;
  /** Extra hostnames that can never be custom domains (the app's own). */
  reserved?: readonly string[];
};

export const DEFAULT_LIMITS: DomainLimits = { perSite: 5, perAccount: 25 };

export function defaultDeps(): DomainDeps {
  return {
    provider: configuredDomainProvider(),
    hosts: { put: putHost, remove: deleteHost },
    limits: DEFAULT_LIMITS,
    reserved: (process.env.RESERVED_DOMAINS ?? "").split(",").map((host) => host.trim()).filter(Boolean),
  };
}

export type Actor = { ownerSub: string; siteId: string; requestId?: string | null };

export type DomainView = {
  domain: SiteDomain;
  /** What the owner still has to add at their DNS host. Empty once active. */
  records: DnsRecord[];
  /** Why the domain isn't active yet, when the provider says. */
  message: string | null;
};

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function requireProvider(deps: DomainDeps): DomainProvider {
  if (!deps.provider) throw new DomainServiceError("unavailable", "Custom domains aren't set up on this service.");
  return deps.provider;
}

async function audit(actor: Actor, event: "site.domain.added" | "site.domain.activated" | "site.domain.deactivated" | "site.domain.removed", hostname: string, ok = true) {
  // The hostname goes in the page_path column: it is the audit row's subject.
  await recordAudit({ event, outcome: ok ? "ok" : "error", actorSub: actor.ownerSub, siteId: actor.siteId, pagePath: hostname, requestId: actor.requestId ?? null });
}

async function recordHostFile(siteId: string, hostname: string): Promise<void> {
  // Recorded like the site's own hostname so closing the organization removes the entry too.
  await query(
    `INSERT INTO site_files (site_id, key, sha256) VALUES ($1, $2, $3)
     ON CONFLICT (site_id, key) DO UPDATE SET sha256 = EXCLUDED.sha256, updated_at = now()`,
    [siteId, `host:${hostname}`, digest(siteId)],
  );
}

async function forgetHostFile(siteId: string, hostname: string): Promise<void> {
  await query("DELETE FROM site_files WHERE site_id = $1 AND key = $2", [siteId, `host:${hostname}`]);
}

/** Starts serving the hostname. Writes the host record, then marks the domain active. */
async function activate(actor: Actor, domain: SiteDomain, deps: DomainDeps): Promise<SiteDomain> {
  await deps.hosts.put(domain.hostname, domain.siteId);
  const active = await setDomainStatus(domain.id, "active");
  if (!active) {
    // Removed while we were activating: don't leave a record behind.
    await deps.hosts.remove(domain.hostname);
    throw new DomainServiceError("not_found", "Domain not found");
  }
  await recordHostFile(domain.siteId, domain.hostname);
  if (domain.status !== "active") await audit(actor, "site.domain.activated", domain.hostname);
  return active;
}

/** Stops serving the hostname, keeping the domain so the owner can fix DNS and retry. */
async function deactivate(actor: Actor, domain: SiteDomain, status: "pending" | "verifying" | "error", message: string | null, deps: DomainDeps): Promise<SiteDomain> {
  if (domain.status === "active") {
    await deps.hosts.remove(domain.hostname);
    await forgetHostFile(domain.siteId, domain.hostname);
    await audit(actor, "site.domain.deactivated", domain.hostname);
  }
  return (await setDomainStatus(domain.id, status, { error: message })) ?? domain;
}

async function apply(actor: Actor, domain: SiteDomain, result: ProviderStatus, deps: DomainDeps): Promise<DomainView> {
  if (result.state === "active") return { domain: await activate(actor, domain, deps), records: [], message: null };
  if (result.state === "error") return { domain: await deactivate(actor, domain, "error", result.message ?? "This domain could not be verified.", deps), records: result.records, message: result.message };
  const target = result.state === "pending" ? "pending" : "verifying";
  const next = domain.status === target ? domain : await deactivate(actor, domain, target, null, deps);
  return { domain: next, records: result.records, message: result.message };
}

export async function addSiteDomain(actor: Actor, input: string, deps: DomainDeps = defaultDeps()): Promise<DomainView> {
  const provider = requireProvider(deps);
  const checked = normalizeHostname(input, { publishDomain: publishDomain(), reserved: deps.reserved });
  if (!checked.ok) throw new DomainServiceError("invalid", checked.reason);
  if (isApex(checked.hostname)) {
    throw new DomainServiceError("invalid", `Bare domains aren't supported yet. Use a subdomain such as www.${checked.hostname}.`);
  }
  try {
    const limit = withinLimits(await countDomains(actor.ownerSub, actor.siteId), deps.limits);
    if (!limit.ok) throw new DomainServiceError("limit", limit.reason);
    const created = await createDomain(actor.ownerSub, actor.siteId, checked.hostname);
    let ref: string | null = null;
    try {
      const added = await provider.add(created.hostname, created.verificationToken);
      ref = added.ref;
      const stored = await setDomainStatus(created.id, "pending", { providerRef: added.ref });
      await audit(actor, "site.domain.added", created.hostname);
      return await apply(actor, stored ?? created, added, deps);
    } catch (error) {
      if (error instanceof DomainServiceError) throw error;
      // The provider or storage failed: free the hostname so the owner can retry.
      if (ref) await provider.remove(ref).catch(() => undefined);
      await deps.hosts.remove(created.hostname).catch(() => undefined);
      await removeDomain(actor.ownerSub, actor.siteId, created.id).catch(() => undefined);
      await audit(actor, "site.domain.added", created.hostname, false);
      throw new DomainServiceError("provider", "We couldn't set up that domain right now. Try again in a moment.");
    }
  } catch (error) {
    if (error instanceof DomainError) throw new DomainServiceError(error.code, error.message);
    throw error;
  }
}

export async function listSiteDomains(actor: Actor): Promise<SiteDomain[]> {
  try {
    return await listDomains(actor.ownerSub, actor.siteId);
  } catch (error) {
    if (error instanceof DomainError) throw new DomainServiceError(error.code, error.message);
    throw error;
  }
}

/** Asks the provider where the domain stands and moves it along. */
export async function checkSiteDomain(actor: Actor, id: string, deps: DomainDeps = defaultDeps()): Promise<DomainView> {
  const provider = requireProvider(deps);
  let domain: SiteDomain | null;
  try {
    domain = await getDomain(actor.ownerSub, actor.siteId, id);
  } catch (error) {
    if (error instanceof DomainError) throw new DomainServiceError(error.code, error.message);
    throw error;
  }
  if (!domain) throw new DomainServiceError("not_found", "Domain not found");
  let result: ProviderStatus;
  try {
    result = await provider.status(domain.providerRef ?? domain.hostname, domain.hostname, domain.verificationToken);
  } catch {
    throw new DomainServiceError("provider", "We couldn't check that domain right now. Try again in a moment.");
  }
  return apply(actor, domain, result, deps);
}

/** Removes the domain: stop serving first, then drop it at the provider, then free the hostname. */
export async function removeSiteDomain(actor: Actor, id: string, deps: DomainDeps = defaultDeps()): Promise<void> {
  let domain: SiteDomain | null;
  try {
    domain = await getDomain(actor.ownerSub, actor.siteId, id);
  } catch (error) {
    if (error instanceof DomainError) throw new DomainServiceError(error.code, error.message);
    throw error;
  }
  if (!domain) throw new DomainServiceError("not_found", "Domain not found");
  // Serving stops before anything else, so a failure below never leaves a live host behind.
  await deps.hosts.remove(domain.hostname);
  await forgetHostFile(domain.siteId, domain.hostname);
  if (deps.provider && domain.providerRef) {
    try {
      await deps.provider.remove(domain.providerRef);
    } catch {
      await setDomainStatus(domain.id, "error", { error: "We couldn't finish removing this domain. Try removing it again." });
      throw new DomainServiceError("provider", "We couldn't finish removing that domain. Try again in a moment.");
    }
  }
  await removeDomain(actor.ownerSub, actor.siteId, domain.id);
  await audit(actor, "site.domain.removed", domain.hostname);
}

/**
 * Re-checks domains that are serving or still waiting, so one whose DNS now
 * points elsewhere stops serving, and one that finished validating starts.
 * Meant to run on a schedule; one failing domain doesn't stop the rest.
 */
export async function reverifyDomains(deps: DomainDeps = defaultDeps(), limit = 200): Promise<{ checked: number; changed: number; failed: number }> {
  const provider = requireProvider(deps);
  const domains = await listDomainsByStatus(["active", "verifying", "pending", "error"], limit);
  let changed = 0;
  let failed = 0;
  for (const domain of domains) {
    const [site] = await query<{ owner_sub: string }>("SELECT owner_sub FROM sites WHERE id = $1", [domain.siteId]);
    if (!site) continue;
    const actor: Actor = { ownerSub: site.owner_sub, siteId: domain.siteId };
    try {
      const result = await provider.status(domain.providerRef ?? domain.hostname, domain.hostname, domain.verificationToken);
      const before = domain.status;
      const view = await apply(actor, domain, result, deps);
      if (view.domain.status !== before) changed += 1;
    } catch {
      failed += 1;
    }
  }
  return { checked: domains.length, changed, failed };
}

import { promises as dns } from "node:dns";
import { isApex } from "./hostname";
import { APEX_NOTE, type DnsRecord, type DomainProvider, type ProviderAdd, type ProviderStatus } from "./provider";

/**
 * For self-hosted instances without Cloudflare for SaaS (#185): the owner adds
 * a CNAME to the instance's front door and a TXT record proving they control
 * the domain, and this provider checks both in DNS. Certificates and routing
 * for the hostname are the operator's job (their own proxy or Caddy-style
 * on-demand TLS); this only reports whether DNS is right.
 */

export type DnsResolver = {
  resolveCname(name: string): Promise<string[]>;
  resolveTxt(name: string): Promise<string[][]>;
  /** Used at the root of a domain, where flattening makes a CNAME look like addresses. */
  resolve4?(name: string): Promise<string[]>;
};

export const CHALLENGE_PREFIX = "_pagefirst-challenge";

export function manualRecords(hostname: string, cnameTarget: string, token: string): DnsRecord[] {
  return [
    { type: "CNAME", name: hostname, value: cnameTarget, purpose: "route", ...(isApex(hostname) ? { note: APEX_NOTE } : {}) },
    { type: "TXT", name: `${CHALLENGE_PREFIX}.${hostname}`, value: token, purpose: "ownership" },
  ];
}

const norm = (value: string) => value.toLowerCase().replace(/\.$/, "");

export function createManualProvider(cnameTarget: string, resolver: DnsResolver = dns): DomainProvider {
  const target = norm(cnameTarget);

  async function check(hostname: string, token: string): Promise<ProviderStatus> {
    const records = manualRecords(hostname, target, token);
    const lookup = async <T>(run: () => Promise<T[]>): Promise<T[]> => run().catch(() => []);
    const [cnames, txts] = await Promise.all([
      lookup(() => resolver.resolveCname(hostname)),
      lookup(() => resolver.resolveTxt(`${CHALLENGE_PREFIX}.${hostname}`)),
    ]);
    let routed = cnames.some((value) => norm(value) === target);
    if (!routed && isApex(hostname) && resolver.resolve4) {
      // Flattening (ALIAS/ANAME) answers with the target's addresses instead of a CNAME.
      const [mine, theirs] = await Promise.all([lookup(() => resolver.resolve4!(hostname)), lookup(() => resolver.resolve4!(target))]);
      routed = mine.length > 0 && mine.some((address) => theirs.includes(address));
    }
    const owned = txts.some((chunks) => chunks.join("") === token);
    if (routed && owned) return { state: "active", message: null, records: [] };
    const missing = [!routed && "the CNAME record", !owned && "the TXT record"].filter(Boolean).join(" and ");
    return { state: "pending", message: `Waiting for ${missing} to appear in DNS.`, records: records.filter((r) => (r.purpose === "route" ? !routed : !owned)) };
  }

  return {
    name: "manual",
    async add(hostname, token): Promise<ProviderAdd> {
      return { ref: hostname, ...(await check(hostname, token)) };
    },
    status: (_ref, hostname, token) => check(hostname, token),
    async remove() {},
  };
}

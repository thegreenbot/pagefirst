import { domainToASCII } from "node:url";

/**
 * Validation and normalization for a site's custom domain (#184). Pure, so the
 * API, the domain service and the Worker can share it. A hostname that passes
 * is lower-case punycode with no trailing dot.
 */

export type HostnameResult = { ok: true; hostname: string } | { ok: false; reason: string };

export type HostnameRules = {
  /** The publish domain (`pagefirst.io`): it and everything under it is refused. */
  publishDomain?: string | null;
  /** Other hostnames that are never custom domains, e.g. the app and API hosts. */
  reserved?: readonly string[];
};

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/** Suffixes that are not registrable on their own and are not a bare `tld`. */
const MULTI_PART_SUFFIXES = new Set([
  "co.uk", "org.uk", "me.uk", "ac.uk", "gov.uk", "ltd.uk", "plc.uk", "net.uk",
  "com.au", "net.au", "org.au", "edu.au", "gov.au",
  "co.nz", "org.nz", "net.nz",
  "co.jp", "or.jp", "ne.jp", "ac.jp",
  "co.in", "net.in", "org.in",
  "com.br", "net.br", "org.br",
  "co.za", "org.za",
  "com.cn", "net.cn", "org.cn",
  "com.mx", "com.ar", "com.tr", "com.sg", "com.hk", "com.tw",
]);

const INTERNAL_SUFFIXES = ["localhost", "localdomain", "local", "internal", "intranet", "lan", "home", "corp", "test", "invalid", "example", "onion", "arpa"];

const strip = (value: string) => value.trim().toLowerCase().replace(/^\*\./, "*.").replace(/\.$/, "");

export function normalizeHostname(input: string, rules: HostnameRules = {}): HostnameResult {
  if (typeof input !== "string") return { ok: false, reason: "Enter a domain name." };
  let raw = input.trim();
  if (!raw) return { ok: false, reason: "Enter a domain name." };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return { ok: false, reason: "Enter the domain only, without http:// or a path." };
  if (/[\s/?#@\\]/.test(raw)) return { ok: false, reason: "Enter the domain only, without a path or spaces." };
  if (/:\d*$/.test(raw)) return { ok: false, reason: "Ports are not allowed." };
  raw = strip(raw);
  if (raw.includes("*")) return { ok: false, reason: "Wildcard domains are not supported." };
  if (raw.includes("_")) return { ok: false, reason: "Underscores are not allowed in a hostname." };

  const ascii = domainToASCII(raw);
  if (!ascii) return { ok: false, reason: "That is not a valid domain name." };
  const hostname = ascii.toLowerCase();
  if (hostname.length > 253) return { ok: false, reason: "That domain name is too long." };

  const labels = hostname.split(".");
  if (labels.length < 2) return { ok: false, reason: "Enter a full domain such as www.example.com." };
  if (labels.every((label) => /^\d+$/.test(label)) || hostname.includes(":")) return { ok: false, reason: "IP addresses are not allowed." };
  if (!labels.every((label) => LABEL.test(label))) return { ok: false, reason: "That is not a valid domain name." };
  if (!TLD.test(labels[labels.length - 1]!)) return { ok: false, reason: "That domain's ending is not valid." };

  if (INTERNAL_SUFFIXES.includes(labels[labels.length - 1]!)) return { ok: false, reason: "Internal and test domains can't be used." };
  if (MULTI_PART_SUFFIXES.has(hostname)) return { ok: false, reason: "That is a public suffix, not a domain you can own." };

  const publish = rules.publishDomain ? strip(rules.publishDomain).replace(/^\*\./, "") : null;
  if (publish && (hostname === publish || hostname.endsWith(`.${publish}`))) {
    return { ok: false, reason: "Addresses on the publish domain can't be used as a custom domain." };
  }
  for (const reserved of rules.reserved ?? []) {
    const value = strip(reserved);
    if (value && (hostname === value || hostname.endsWith(`.${value}`))) return { ok: false, reason: "That domain is reserved." };
  }
  return { ok: true, hostname };
}

/** True when `hostname` is a registrable domain itself (`example.com`), not a subdomain. */
export function isApex(hostname: string): boolean {
  const labels = hostname.split(".");
  if (labels.length === 2) return true;
  const suffix = labels.slice(1).join(".");
  return labels.length === 3 && MULTI_PART_SUFFIXES.has(suffix);
}

export type DomainLimits = { perSite: number; perAccount: number };

/** Whether another domain fits under the plan's limits (#189 supplies the numbers). */
export function withinLimits(counts: { site: number; account: number }, limits: DomainLimits): { ok: true } | { ok: false; reason: string } {
  if (counts.site >= limits.perSite) return { ok: false, reason: `This site already has ${counts.site} custom domain${counts.site === 1 ? "" : "s"}, the most its plan allows.` };
  if (counts.account >= limits.perAccount) return { ok: false, reason: "This account has reached its custom domain limit." };
  return { ok: true };
}

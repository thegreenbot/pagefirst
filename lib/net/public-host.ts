import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";

/**
 * Outbound calls to a customer-supplied URL (webhooks, #40) must not reach our
 * own network. The URL is checked up front, and the address is checked again
 * at connect time, so a name that later resolves to a private address (DNS
 * rebinding) is refused too.
 */

/** True for an address on the public internet. Loopback, private, link-local, CGNAT, multicast and reserved ranges are not. */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return isPublicV4(address);
  if (version === 6) return isPublicV6(address.toLowerCase());
  return false;
}

function isPublicV4(address: string): boolean {
  const [a, b, c] = address.split(".").map(Number) as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return a < 224; // multicast and reserved
}

function isPublicV6(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (mapped) return isPublicV4(mapped[1]!);
  if (address === "::" || address === "::1") return false;
  const first = parseInt(address.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return false; // unique local
  if ((first & 0xffc0) === 0xfe80) return false; // link-local
  if ((first & 0xff00) === 0xff00) return false; // multicast
  if (address.startsWith("2001:db8")) return false; // documentation
  return true;
}

export class UnsafeUrlError extends Error {}

/** A webhook URL we are willing to call: https on the default port, a real hostname, no credentials. */
export function validateWebhookUrl(raw: unknown): URL {
  if (typeof raw !== "string" || raw.length > 2048) throw new UnsafeUrlError("url must be a string of at most 2048 characters.");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("url is not a valid URL.");
  }
  if (url.protocol !== "https:") throw new UnsafeUrlError("url must use https.");
  if (url.username || url.password) throw new UnsafeUrlError("url must not contain credentials.");
  if (url.port && url.port !== "443") throw new UnsafeUrlError("url must use the default https port.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) throw new UnsafeUrlError("url must use a hostname, not an IP address.");
  if (!host.includes(".") || /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i.test(host)) throw new UnsafeUrlError("url must name a public host.");
  return url;
}

/** A `lookup` for http(s).request that refuses any non-public address, checked at connect time. */
export function publicLookup(
  hostname: string,
  options: unknown,
  callback: (error: Error | null, address?: string | LookupAddress[], family?: number) => void,
): void {
  const wantsAll = typeof options === "object" && options !== null && (options as { all?: boolean }).all === true;
  dnsLookup(hostname, { all: true, verbatim: true }, (error, addresses) => {
    if (error) return callback(error);
    const bad = addresses.find((entry) => !isPublicAddress(entry.address));
    if (bad || addresses.length === 0) return callback(new UnsafeUrlError("The host does not resolve to a public address."));
    if (wantsAll) return callback(null, addresses);
    callback(null, addresses[0]!.address, addresses[0]!.family);
  });
}

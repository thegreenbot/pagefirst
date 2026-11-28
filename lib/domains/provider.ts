/**
 * What the app needs from whatever routes and secures a custom domain (#185).
 * The hosted service uses Cloudflare for SaaS custom hostnames; a self-hosted
 * instance without it can use the manual DNS-checking provider. The domain
 * service (#186) only talks to this interface.
 */

export type DnsRecord = {
  type: "CNAME" | "TXT";
  /** The record's host, fully qualified, e.g. `www.example.com`. */
  name: string;
  value: string;
  /** What the owner should be told the record is for. */
  purpose: "route" | "ownership" | "certificate";
};

export type ProviderState = "pending" | "verifying" | "active" | "error";

export type ProviderStatus = {
  state: ProviderState;
  /** A readable reason, set when `state` is `error` or the provider is still waiting on DNS. */
  message: string | null;
  /** The records the owner still needs at their DNS host. */
  records: DnsRecord[];
};

export type ProviderAdd = ProviderStatus & {
  /** An id the provider needs to look the hostname up or remove it again. */
  ref: string;
};

export interface DomainProvider {
  readonly name: string;
  /** Registers a hostname. `token` is the domain's verification token. Idempotent for the same hostname. */
  add(hostname: string, token: string): Promise<ProviderAdd>;
  status(ref: string, hostname: string, token: string): Promise<ProviderStatus>;
  /** Stops routing the hostname. A hostname that is already gone is not an error. */
  remove(ref: string): Promise<void>;
}

/** The provider error the owner can see: never carries a token or a response body. */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

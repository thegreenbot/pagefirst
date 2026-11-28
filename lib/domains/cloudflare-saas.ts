import { type DnsRecord, type DomainProvider, type ProviderAdd, ProviderError, type ProviderStatus } from "./provider";

/**
 * Cloudflare for SaaS custom hostnames on the publish zone (#185). The owner
 * points a CNAME at the fallback target; Cloudflare validates the hostname,
 * issues and renews the certificate, and sends the request to the Worker.
 *
 * The token needs only "SSL and Certificates: Edit" on that one zone.
 * Errors carry the HTTP status, never a response body, so nothing a caller
 * sent or a token can leak into logs or the editor.
 */

const API = "https://api.cloudflare.com/client/v4";

export type CloudflareSaasConfig = {
  zoneId: string;
  token: string;
  /** Where owners point their CNAME, e.g. `domains.pagefirst.io`. */
  cnameTarget: string;
};

export function cloudflareSaasConfig(env: Record<string, string | undefined> = process.env): CloudflareSaasConfig | null {
  const zoneId = env.CLOUDFLARE_SAAS_ZONE_ID?.trim();
  const token = env.CLOUDFLARE_SAAS_API_TOKEN?.trim();
  const cnameTarget = env.CUSTOM_DOMAIN_CNAME_TARGET?.trim().toLowerCase().replace(/\.$/, "");
  return zoneId && token && cnameTarget ? { zoneId, token, cnameTarget } : null;
}

type CustomHostname = {
  id?: string;
  status?: string;
  verification_errors?: string[];
  ownership_verification?: { type?: string; name?: string; value?: string };
  ssl?: {
    status?: string;
    validation_records?: { txt_name?: string; txt_value?: string }[];
    validation_errors?: { message?: string }[];
  };
};

export function mapCustomHostname(hostname: string, cnameTarget: string, result: CustomHostname): ProviderStatus {
  const records: DnsRecord[] = [{ type: "CNAME", name: hostname, value: cnameTarget, purpose: "route" }];
  const ownership = result.ownership_verification;
  if (ownership?.type === "txt" && ownership.name && ownership.value) {
    records.push({ type: "TXT", name: ownership.name, value: ownership.value, purpose: "ownership" });
  }
  for (const record of result.ssl?.validation_records ?? []) {
    if (record.txt_name && record.txt_value) records.push({ type: "TXT", name: record.txt_name, value: record.txt_value, purpose: "certificate" });
  }

  const status = result.status ?? "pending";
  const ssl = result.ssl?.status ?? "initializing";
  if (status === "active" && ssl === "active") return { state: "active", message: null, records: [] };
  if (status === "blocked") return { state: "error", message: "This domain can't be used.", records };
  if (status === "deleted" || status === "moved") return { state: "error", message: "This domain is no longer set up. Remove it and add it again.", records };
  if (/validation_timed_out|timed_out|deactivating/.test(ssl) || ssl === "deleted") {
    return { state: "error", message: "The certificate could not be issued in time. Check the DNS records, then try again.", records };
  }
  if (status === "active") return { state: "verifying", message: "The domain is verified. The certificate is being issued.", records: records.filter((r) => r.purpose === "certificate") };
  const hint = result.verification_errors?.[0] ?? null;
  return { state: status === "pending" ? "pending" : "verifying", message: hint ? "Waiting for DNS: the records below aren't visible yet." : "Waiting for DNS to point at us.", records };
}

export function createCloudflareSaasProvider(config: CloudflareSaasConfig, fetchImpl: typeof fetch = fetch): DomainProvider {
  const base = `${API}/zones/${encodeURIComponent(config.zoneId)}/custom_hostnames`;

  async function call(method: "GET" | "POST" | "DELETE", url: string, body?: unknown): Promise<{ status: number; result: CustomHostname | null }> {
    const response = await fetchImpl(url, {
      method,
      headers: { Authorization: `Bearer ${config.token}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const payload = (await response.json().catch(() => null)) as { result?: CustomHostname } | null;
    return { status: response.status, result: payload?.result ?? null };
  }

  return {
    name: "cloudflare-saas",

    async add(hostname): Promise<ProviderAdd> {
      const created = await call("POST", base, {
        hostname,
        ssl: { method: "http", type: "dv", settings: { min_tls_version: "1.2" } },
      });
      if (created.status === 200 && created.result?.id) {
        return { ref: created.result.id, ...mapCustomHostname(hostname, config.cnameTarget, created.result) };
      }
      if (created.status === 409) {
        // Already registered (a retry): find it rather than fail.
        const found = await call("GET", `${base}?hostname=${encodeURIComponent(hostname)}`);
        const first = Array.isArray(found.result) ? (found.result[0] as CustomHostname | undefined) : undefined;
        if (first?.id) return { ref: first.id, ...mapCustomHostname(hostname, config.cnameTarget, first) };
        throw new ProviderError("That hostname is already registered elsewhere", 409);
      }
      throw new ProviderError(`Domain provider answered ${created.status}`, created.status);
    },

    async status(ref, hostname): Promise<ProviderStatus> {
      const got = await call("GET", `${base}/${encodeURIComponent(ref)}`);
      if (got.status === 404) return { state: "error", message: "This domain is no longer set up. Remove it and add it again.", records: [] };
      if (got.status !== 200 || !got.result) throw new ProviderError(`Domain provider answered ${got.status}`, got.status);
      return mapCustomHostname(hostname, config.cnameTarget, got.result);
    },

    async remove(ref): Promise<void> {
      const gone = await call("DELETE", `${base}/${encodeURIComponent(ref)}`);
      if (gone.status !== 200 && gone.status !== 404) throw new ProviderError(`Domain provider answered ${gone.status}`, gone.status);
    },
  };
}

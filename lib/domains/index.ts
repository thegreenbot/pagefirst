import { cloudflareSaasConfig, createCloudflareSaasProvider } from "./cloudflare-saas";
import { createManualProvider } from "./manual-provider";
import type { DomainProvider } from "./provider";

export type { DnsRecord, DomainProvider, ProviderAdd, ProviderState, ProviderStatus } from "./provider";
export { ProviderError } from "./provider";

/**
 * The configured provider, or null when custom domains aren't set up on this
 * instance. `DOMAIN_PROVIDER` is `cloudflare-saas` (hosted) or `manual`.
 */
export function configuredDomainProvider(env: Record<string, string | undefined> = process.env): DomainProvider | null {
  const kind = env.DOMAIN_PROVIDER?.trim().toLowerCase();
  if (kind === "cloudflare-saas") {
    const config = cloudflareSaasConfig(env);
    return config ? createCloudflareSaasProvider(config) : null;
  }
  if (kind === "manual") {
    const target = env.CUSTOM_DOMAIN_CNAME_TARGET?.trim();
    return target ? createManualProvider(target) : null;
  }
  return null;
}

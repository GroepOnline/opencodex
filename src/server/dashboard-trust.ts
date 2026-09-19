import { isCfAccessTrustedHost } from "./cf-access-auth";
import { isOidcTrustedHost } from "./oidc-auth";

/** Public dashboard hosts trusted by Cloudflare Access and/or Authentik OIDC. */
export function isDashboardTrustedHost(hostname: string | undefined): boolean {
  return isCfAccessTrustedHost(hostname) || isOidcTrustedHost(hostname);
}

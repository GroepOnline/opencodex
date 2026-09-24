import { verifyCfAccessRequest } from "./cf-access-auth";
import { verifyOidcRequest } from "./oidc-auth";

export type SessionIdentitySource = "cf-access" | "oidc" | "none";

export type SessionIdentityView = {
  email: string | null;
  source: SessionIdentitySource;
};

/**
 * Human dashboard identity after management auth already passed.
 * Email only — never tokens, subjects, or JWTs.
 */
export async function resolveSessionIdentity(
  req: Request,
): Promise<SessionIdentityView> {
  const access = await verifyCfAccessRequest(req);
  if (access?.email) return { email: access.email, source: "cf-access" };
  const oidc = await verifyOidcRequest(req);
  if (oidc?.email) return { email: oidc.email, source: "oidc" };
  return { email: null, source: "none" };
}

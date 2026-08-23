import { buildAuthenticatedProvenance, buildPublicProvenance } from "../build-provenance";
import { MANAGEMENT_CONTRACT_VERSION } from "../contract-version";
import { buildHealthContract } from "../health-contract";
import { jsonResponse } from "../auth-cors";
import type { OcxConfig } from "../../types";
import type { ManagementContext } from "./context";

export function buildProvenanceResponse(
  config: OcxConfig,
  listenPort: number,
  authenticated: boolean,
  managementAuthAvailable: boolean,
  req?: Request,
): Response {
  const body = authenticated
    ? buildAuthenticatedProvenance(config as unknown as Record<string, unknown>, listenPort, managementAuthAvailable)
    : buildPublicProvenance(config as unknown as Record<string, unknown>, listenPort);
  return jsonResponse(body, 200, req, config);
}

export async function handleProvenanceRoutes(
  ctx: ManagementContext,
  opts: { listenPort: number; managementAuthAvailable: boolean; authenticated: boolean },
): Promise<Response | null> {
  const { req, url, config } = ctx;

  if (url.pathname === "/api/provenance" && req.method === "GET") {
    return buildProvenanceResponse(
      config,
      opts.listenPort,
      opts.authenticated,
      opts.managementAuthAvailable,
      req,
    );
  }

  if (url.pathname === "/api/health" && req.method === "GET") {
    return jsonResponse(buildHealthContract(config, {
      managementAuthAvailable: opts.managementAuthAvailable,
      contractVersion: MANAGEMENT_CONTRACT_VERSION,
    }), 200, req, config);
  }

  return null;
}

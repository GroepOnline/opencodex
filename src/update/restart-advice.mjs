/**
 * Post-update guidance for a foreground (non-service) installation.
 *
 * Shared by the npm launcher (bin/ocx.mjs) and the Bun updater (src/update/index.ts),
 * so it stays plain JS with no imports.
 *
 * Only a proxy this machine was running (pid or runtime-port record, stopped before the
 * package was replaced) gets a plain restart instruction on the stopped port. Without
 * that local runtime state the port may belong to an externally managed listener, such
 * as a systemd socket or SSH tunnel to another host. Starting a second proxy there
 * would compete with a healthy listener, so the caveat is printed first and the start
 * command is offered only as a conditional, without prescribing a port that may belong
 * to the tunnel.
 *
 * @param {{ stoppedLocalProxy: boolean, port: number, proxyOnly?: boolean }} input
 * @returns {string[]}
 */
export function foregroundRestartAdvice({
  stoppedLocalProxy,
  port,
  proxyOnly = false,
}) {
  const proxyOnlySuffix = proxyOnly ? " --proxy-only" : "";
  if (stoppedLocalProxy) {
    return [
      `Restart the local proxy that was stopped for the update:  ocx start --port ${port}${proxyOnlySuffix}`,
    ];
  }
  return [
    "No local proxy was running on this machine, so none was stopped or restarted.",
    "For an externally managed gateway or tunnel, keep the existing listener; do not start a second proxy.",
    `If this machine should run its own proxy instead, start it:  ocx start${proxyOnlySuffix}`,
  ];
}

# Remote client artifacts

Build a versioned client candidate from a clean runtime checkout:

```sh
bun install --frozen-lockfile
bun run build:client --output /path/to/client-artifacts/new-candidate
bun /path/to/client-artifacts/new-candidate/src/cli/index.js --version
```

To rebuild an older pinned source revision with the current reviewed builder,
pass its clean checkout explicitly:

```sh
bun run build:client --output /path/to/client-artifacts/new-candidate \
  --source-root /path/to/clean-pinned-checkout
```

The destination must not exist. This command never activates a candidate,
changes a `current` link, reads home configuration or starts a proxy. Runtime
source and lockfile changes must be committed first. Source provenance is the
checkout HEAD; package metadata comes from that Git revision, while the
manifest separately records the builder digest and Bun version.

The artifact preserves the remote launcher's contract: `src/cli/index.js`,
`package.json`, `source-sha` and `index.js.sha256`. It also ships the executable
`bin/codex.ocx-client` shim for an operator-controlled install step. The shim
always selects `OCX_CLIENT_CODEX_HOME` or its isolated default `~/.codex-ocx`;
it ignores an inherited `CODEX_HOME` and explicitly refuses the native
`~/.codex` home. `OCX_CLIENT_OCX_BIN` and `OCX_CLIENT_CODEX_BIN` can select the
governed remote launcher and real Codex executable during installation.

The CLI and its imported dependencies and upstream model snapshot are bundled;
package metadata remains alongside the bundle for version reporting. This is
not a GUI, tray, service or storage-worker distribution. Explicit local
lifecycle commands fail closed even when the bundle is invoked directly.
Continue using the existing governed remote launcher for remote connectivity
and command authorization; it prevents indirect lifecycle paths too. Building
a candidate does not replace a globally installed shim or modify either the
isolated or native Codex home.

Before activation, review the exact source revision, run the catalog sync
regressions and harmless version probe, and compare the bundle checksum against
`index.js.sha256`. `artifact-manifest.json` additionally binds the package,
lockfile, builder and Bun version. Artifact integrity does not prove provider
availability or healthy remote deployment. Activation and rollback of the
launcher-managed `current` link are separate operator actions.

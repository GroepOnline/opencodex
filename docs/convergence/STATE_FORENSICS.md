# Runtime state forensics

OpenCodex persists product state in local configuration/state files rather than
requiring a database. This document records the public methodology for
determining state authority without publishing a specific operator's production
topology.

## What to inventory

For every candidate runtime, record:

- exact OpenCodex version and source/package identity;
- effective configuration root and state paths;
- service manager ownership and the process actually holding the listen socket;
- credential *references* and environment variable names, never credential values;
- config/session/provider state file names, sizes, mtimes and hashes;
- backups and snapshots that can restore those files;
- whether generated Codex/client artifacts are authoritative or reproducible.

## Authority rules

1. A running process is not automatically the state authority.
2. A deployment checkout is not automatically the state authority.
3. Generated client/shim/catalog files are derived unless the product explicitly
   documents otherwise.
4. Secret files and browser/OAuth material must be inspected only by metadata or
   hash/reference; do not copy values into evidence.
5. If an older candidate state store is unreachable, completeness remains
   unproven until it is recovered or explicitly retired with evidence.

## Safe evidence collection

Prefer read-only commands such as `ocx doctor`, `ocx status`,
`systemctl show`, `stat`, `find`, checksums, and configuration validation.
Capture host-specific results in the deployment operator's private repository,
not in this public product repository.

The public repository owns the product's state semantics and recovery tooling.
Production hostnames, private network addresses, release-tree paths, account
identifiers, provider fleet inventory and incident evidence are deployment
state and must remain private.

# Local k3s path

`scripts/local-runtime.sh` is the local runner. It does not call GitHub Actions.

```bash
bash scripts/local-runtime.sh status
bash scripts/local-runtime.sh up
bash scripts/local-runtime.sh check
bash scripts/local-runtime.sh down
```

`up` leaves an existing loopback proxy on `:10100` alone. Otherwise it applies
[`opencodex.yaml`](./opencodex.yaml) when `k3s kubectl` can list nodes, and
otherwise runs repo-root `docker compose up -d --build`. ClickHouse is the
compose profile `observability` (`OPENCODEX_WITH_CLICKHOUSE=1`).

Import the locally built image into k3s as `opencodex:local` before the
manifest can become Ready (`imagePullPolicy: Never`). The manifest does not
pull from a registry.

If neither runtime exists, `up` exits non-zero and prints the missing command
(`k3s` / `docker`) or the `docker info` failure. That is the blocker to fix
on the machine; the script does not weaken the container security options to
get past it.

# Kithable — DEV vs PROD Environment Breakdown

_Reference: state on branch `007-dev-env`, 2026-04-18._

Where every artifact lives and how it moves between the local MicroK8s cluster (orchestrated by Tilt from `Kithable/workspace`) and a production tenant cluster (MicroK8s on Hetzner).

## Summary Table

| Artifact | DEV (local MicroK8s via Tilt) | PROD (Hetzner MicroK8s, per-tenant) |
|---|---|---|
| **Core Helm chart** | `platform/charts/kithable-core/` — rendered+applied via `k8s_yaml(helm(...))` in `workspace/Tiltfile` (no real Helm release) | Same chart source, installed as a real `helm install kithable-core` release on each tenant cluster |
| **Module Helm charts** | `mod-*/charts/mod-*` (or `platform/charts/mod-*` fallback) — packaged + pushed by Tilt to the MicroK8s `container-registry` addon at `oci://localhost:32000/kithable/charts` (pod-side: `registry.container-registry.svc.cluster.local:5000`), plain HTTP | Pushed by each `mod-*` repo's GitHub Actions CI to `oci://ghcr.io/kithable/charts/<chart>` over TLS |
| **Docker images** (`api`, `web`, `mod-*`) | Built locally by Tilt (`docker_build`) as `kithable/<name>:dev`. Tilt auto-rewrites refs to the cluster's `localhost:32000/...` registry. Hot-reload via `live_update` | Built by CI (`docker/build-push-action@v5`) and pushed to `ghcr.io/kithable/<image>:<sha>` + `:latest` |
| **npm packages** (`@kithable/*`) | Same source in `platform/packages/*`; consumed via workspace install **or** published to GitHub Packages (`https://npm.pkg.github.com`). Local auth via gitignored per-repo `.npmrc` with a PAT (`read:packages` + `write:packages`) | Same registry, same scope. CI publishes with `${{ secrets.GITHUB_TOKEN }}`; modules depend on `@kithable/*` at `^1.0.0` |
| **Module registry JSON** | `platform/charts/kithable-core/templates/module-registry-cm.yaml` — `chart` field is templated from `moduleRegistry.ociBase`. Dev override: `oci://registry.container-registry.svc.cluster.local:5000/kithable` | Default in `values.yaml`: `oci://ghcr.io/kithable` |
| **Chart values** | `workspace/dev-values/*.yaml` (core.yaml + one per module) — layered on top of each chart's own `values.yaml` | Only each chart's `values.yaml` + prod-specific overrides the Lifecycle API passes per tenant |
| **TLS / ingress** | Traefik `web` entrypoint (plain HTTP), port-forwarded `localhost:8888`; `*.kithable.test` via `/etc/hosts`. Dev values: `ingress.entryPoints: [web]`, `tls: null` | Traefik `websecure` + Let's Encrypt; real domains per tenant |
| **Insecure OCI pulls** | `api.helmInsecureRegistries: "registry.container-registry.svc.cluster.local:5000,localhost:32000"` (triggers `--plain-http`) | Empty — TLS required, standard OCI pull from GHCR |
| **Dev-only images** | `kithable/dev-seed:latest` (seed Job runner: helm, kubectl, psql, python3, bash), MailDev (`maildev/maildev:2.2.1`) | Not present. `seed.enabled: false`, `maildev.enabled: false` |
| **Registry auth** | MicroK8s registry addon is unauthenticated (local only) | CI uses `GITHUB_TOKEN` with `packages: write`; API pod uses a ServiceAccount-bound GHCR credential (via `helm registry login ghcr.io`) |
| **Tenant identity** | Single tenant hardcoded: `slug=dev`, `domain=kithable.test` (set from `Tiltfile` + `dev-values/core.yaml`) | Per-tenant values; one MicroK8s cluster per customer VPS |

## Non-Obvious Pieces

### 1. The chart sources are identical between dev and prod

There is no separate "dev chart". Only two things differ:

- the **values file(s)** layered on top, and
- the **OCI registry endpoint** the `module-registry` ConfigMap points at.

The same `helm install` code path in the Module Lifecycle API (`platform/apps/api/src/modules/helm-client.ts`) runs in both places. Dev just resolves `oci://registry.container-registry.svc...` with `--plain-http`; prod resolves `oci://ghcr.io/kithable/...` over TLS.

### 2. Dev has a registry inside the cluster that prod doesn't need

`microk8s enable registry` gives you:
- `localhost:32000` from the host (how Tilt's `helm push` reaches it)
- `registry.container-registry.svc.cluster.local:5000` from pods (how the API reaches it)

Tilt's `local_resource("mod-*-chart")` watches each module's chart directory and re-runs `helm package` + `helm push --plain-http` on every change. The API's install path then pulls from that registry — so the real `helm install oci://...` flow is exercised locally without anything touching GHCR.

### 3. The core chart in dev is not a real Helm release

```starlark
k8s_yaml(helm("./platform/charts/kithable-core", ...))
```

This **renders** the chart to manifests and applies them directly — faster Tilt reconcile loop, no Helm release metadata on the cluster. The seed Job's `helm.sh/hook: post-install,post-upgrade` annotations are inert here (no hook engine running), but the Job manifest is still applied and runs once, which is the behavior needed for fresh-boot bootstrap.

Prod uses a real `helm install kithable-core` release, so the hook annotations fire for real.

### 4. npm points at the same registry in both environments

`@kithable/*` always resolves from `https://npm.pkg.github.com`. Only the auth source differs:
- **Local**: PAT in each repo's gitignored `.npmrc`
- **CI**: `${{ secrets.GITHUB_TOKEN }}`

Modules never use `file:` deps or git URLs — they consume `^1.0.0` semver even on your laptop. This enforces real publish/consume discipline during local dev.

### 5. The web app serves differently per env

| | DEV | PROD |
|---|---|---|
| Pod runtime | Vite dev server | nginx |
| Pod port | `5173` | `80` |
| Service port | `80` (unchanged) | `80` |
| `publicUrl` | `http://app.kithable.test:8888` | real tenant domain |
| Entrypoint | Traefik `web` (plain HTTP) | Traefik `websecure` |

The Service externally keeps `port: 80` so no Traefik IngressRoute change is needed between environments — only the pod `targetPort` flips.

### 6. Modules install via the real API path in dev

Modules are **not** applied by Tilt via `k8s_yaml(helm(...))` anymore. Each module chart gets packaged + pushed to the local OCI registry on file changes, and the Module Lifecycle API does the actual install:

- On fresh boot: the `seed` Job (core chart `post-install,post-upgrade` hook, activated by `seed.enabled: true` in `dev-values/core.yaml`) auto-installs the modules listed in the dev tenant's `extensions` set.
- On demand: an admin clicks **Install** in the UI → API calls `helm install` → namespace created via `ensureNamespace()` → release lands in `mod-<name>` namespace.

This is exactly the prod install path, tested locally on every dev boot.

## Key File Paths

| Purpose | Path |
|---|---|
| Tilt orchestration | `workspace/Tiltfile` |
| Dev chart overrides | `workspace/dev-values/core.yaml`, `workspace/dev-values/mod-*.yaml` |
| Core chart | `platform/charts/kithable-core/` |
| Core chart defaults | `platform/charts/kithable-core/values.yaml` |
| Module registry template | `platform/charts/kithable-core/templates/module-registry-cm.yaml` |
| Seed Job template | `platform/charts/kithable-core/templates/seed-job.yaml` |
| Seed runner image | `platform/infra/docker/dev-seed/Dockerfile` |
| Seed orchestration script | `platform/infra/scripts/seed-dev.sh` |
| Helm client (install/upgrade/uninstall) | `platform/apps/api/src/modules/helm-client.ts` |
| Module charts (extracted) | `mod-<name>/charts/mod-<name>/` |
| Module charts (fallback, pre-extraction) | `platform/charts/mod-<name>/` |

## Flow: DEV Boot → Module Installed

```text
tilt up
  │
  ├── applies namespace kithable-core
  ├── renders + applies core chart (k8s_yaml(helm(...)))
  │     → API, web, postgres, nats, kratos, hydra, traefik, maildev, module-registry ConfigMap
  │     → seed Job (still runs despite no hook engine)
  ├── docker_build kithable/api:dev, kithable/web:dev, kithable/mod-*:dev
  │     → Tilt pushes to localhost:32000
  └── for each mod-*:
        local_resource("mod-<name>-chart"):
          helm package → helm push --plain-http
            → oci://localhost:32000/kithable/charts/mod-<name>:0.1.0

Seed Job runs:
  reads dev tenant's extensions from Postgres
  for each module ID:
    kubectl create ns mod-<name> --dry-run=client | kubectl apply -f -
    helm upgrade --install mod-<name> \
      oci://registry.container-registry.svc.cluster.local:5000/kithable/charts/mod-<name> \
      --version 0.1.0 --plain-http \
      -f dev-values/mod-<name>.yaml
```

## Flow: PROD Tenant Provision → Module Installed

```text
CI (per mod-* repo):
  docker buildx build . --push → ghcr.io/kithable/mod-<name>:<sha>
  helm package charts/mod-<name> → push oci://ghcr.io/kithable/charts/mod-<name>:X.Y.Z

Tenant provision:
  helm install kithable-core platform/charts/kithable-core \
    -f values-<tenant>.yaml

Admin clicks Install on mod-<name> in the UI:
  API (helm-client.ts):
    ensureNamespace("mod-<name>")
    helm install mod-<name> \
      oci://ghcr.io/kithable/charts/mod-<name> \
      --version X.Y.Z \
      -f <tenant-specific-values>
```

The install code path is the **same function** in `helm-client.ts` for both. The only runtime differences are:
- which `ociBase` the module-registry ConfigMap renders
- whether `--plain-http` is added (controlled by `api.helmInsecureRegistries`)
- which values get merged on top

---

_This is a snapshot. Check `workspace/Tiltfile`, `workspace/dev-values/*.yaml`, and `platform/charts/kithable-core/values.yaml` for the current state._

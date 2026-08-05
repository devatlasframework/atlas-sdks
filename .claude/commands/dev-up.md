---
description: Bring the local ATLAS environment up — Docker Desktop, the k3d cluster, and the atlas-dev workloads — then prove it actually serves before handing over the URLs
argument-hint: <env, e.g. dev | qa — optional, defaults to dev>
---

Bring the local ATLAS stack up so the app can be used in a browser, and **prove it works
before saying it is ready**. Target namespace: `atlas-$ARGUMENTS` (default `atlas-dev`).

You run every command yourself and report a short scoreboard. "Pods are Running" is not the
finish line — the finish line is an HTTP 200 from the ingress and the right image SHA.

## 1. Diagnose before acting

Never start blindly; find out which layer is actually down, because each has a different fix
and the wrong one wastes minutes:

```
docker ps                      # engine
k3d cluster list               # does the cluster EXIST, and is it running?
kubectl get nodes              # is the API server reachable?
kubectl get deploy -n atlas-dev
```

Report the layer that is down. The usual causes, in order of likelihood:

- **`wsl --shutdown`** (or a reboot) — takes out Docker Desktop's backend AND stops the k3d
  containers. Both layers need bringing back.
- **Docker Desktop quit** — engine pipe missing entirely.
- **The cluster was stopped** by `/dev-down` — containers exist but are not running.

## 2. Docker Desktop

If `docker ps` fails, check whether the process is running
(`Get-Process 'Docker Desktop'`). If not, launch it:

```
Start-Process "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
```

**Check `$env:LOCALAPPDATA` equals `C:\Users\<user>\AppData\Local` first.** Claude tool shells
have virtualised that path before, and Docker Desktop reads its settings from there — starting
it against a phantom profile is worse than not starting it. If the path looks virtualised, ask
the user to start Docker Desktop themselves.

Then wait for it **with `docker ps`, not `docker info`**. The named pipe appears well before
the engine serves: there is a window where the pipe exists and every call returns
`500 Internal Server Error`, and a readiness check that only tests the pipe will call it up
too early.

```
until docker ps >/dev/null 2>&1; do sleep 5; done
```

## 3. The cluster — start, do not create

This is the trap that has cost real time more than once:

- **Cluster exists but is stopped → `k3d cluster start atlas`.**
  `bash atlas-infra/scripts/cluster.sh up` does **not** start a stopped cluster — it has no
  `k3d cluster start` in it, so on a stopped cluster it reconciles ports and namespaces, prints
  success, and leaves everything down. `deploy-dev` then fails for reasons that look unrelated.
- **Cluster does not exist at all → `bash atlas-infra/scripts/cluster.sh up`.** Say plainly
  that a fresh cluster has **no workloads**: it needs a deploy (dispatch `deploy-dev.yml` in
  `atlas-infra`, or `deploy.sh`) _and_ `secrets.sh apply dev`, which is a much longer road than
  a restart. Do not start down it without telling the user.

Docker Desktop often restarts the k3d containers by itself when the engine comes back — check
before running anything.

**Shell note:** use Git Bash or PowerShell for `k3d`/`kubectl`. Plain `bash` invoked from
PowerShell is WSL, which cannot see the Windows k3d binary or its Docker context.

## 4. Wait for the workloads

```
kubectl wait --for=condition=Available --timeout=600s deployment --all -n atlas-dev
```

Postgres, Redis, MinIO and clamd are StatefulSets — check them separately with
`kubectl get pods`. clamd is slow to become ready (it loads signature databases); a few
restarts there after a cold start are normal and not a failure.

## 5. Prove it serves — do not skip this

| Check                       | Command                                                                                             |
| --------------------------- | --------------------------------------------------------------------------------------------------- |
| Pods ready, restarts sane   | `kubectl get pods -n atlas-dev`                                                                     |
| The image actually deployed | `kubectl get deploy atlas-web -n atlas-dev -o jsonpath='{.spec.template.spec.containers[0].image}'` |
| The ingress answers         | `curl -sk -o /dev/null -w "%{http_code}" https://atlas.dev.127.0.0.1.nip.io/login`                  |

Compare the image SHA against `git log --oneline -1 origin/develop`. **If they differ, Dev is
stale** — CD did not land the latest merge. Say so; do not let the user click through an old
build believing it is current. `curl` needs `-k` (private CA) or
`--ssl-revoke-best-effort` on schannel.

## 6. Hand over

Print the URLs and what is on them:

- **Web:** `https://atlas.dev.127.0.0.1.nip.io`
- **API:** `https://api.dev.127.0.0.1.nip.io`
- **Storage (MinIO):** `https://storage.dev.127.0.0.1.nip.io`
- **Mailpit** (verification/reset emails): `kubectl port-forward -n atlas-dev svc/atlas-mailpit 8025:8025`

Close with the running image SHA and a one-line state summary, and remind the user that
**`/dev-down` stops the cluster** when they are finished — it holds several GB of RAM open.

## Notes worth surfacing when they apply

- The whole rig (dev + qa + prod namespaces) shares one k3d node of roughly 15.7 GiB. Prod
  (~10.5 G) and a full QA (~6.3 G) do not fit together — scale `atlas-prod` to 0 for a QA
  window. Durable fix: `memory=24GB` in `~/.wslconfig`.
- A cluster that has never had `secrets.sh apply dev` run against it will boot an api that
  crash-loops on missing `ATLAS_JWT_SECRET` / `ATLAS_MFA_ENCRYPTION_KEY`. That reads like a
  code failure and is not one.

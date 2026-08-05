---
description: Take the local ATLAS environment down and reclaim its memory — stops the k3d cluster by default, preserving every deployed workload so /dev-up is a one-minute restart
argument-hint: <blank = stop the cluster | docker = also quit Docker Desktop | delete = DESTROY the cluster>
---

Take the local stack down and give the machine its RAM back. `$ARGUMENTS` selects how far:

| `$ARGUMENTS` | What happens                                                          | Cost to come back                          |
| ------------ | --------------------------------------------------------------------- | ------------------------------------------ |
| _(blank)_    | `k3d cluster stop atlas` — containers stopped, everything preserved   | `/dev-up`, about a minute                  |
| `docker`     | the above **plus** quit Docker Desktop — releases the WSL VM's memory | `/dev-up`, a few minutes                   |
| `delete`     | `cluster.sh down` — **destroys** the cluster and its registry         | full redeploy **+ `secrets.sh apply dev`** |

**Default to stopping. Never delete unless the user asked for it in those words.**

## Why stop rather than down

`bash atlas-infra/scripts/cluster.sh down` runs `k3d cluster delete` — it removes the cluster
**and** the registry. Every deployed workload, every namespace, the Postgres volume and the
applied secrets all go with it. Coming back is not `/dev-up`: it is `cluster.sh up`, a fresh
`deploy-dev` dispatch, and `secrets.sh apply dev` before the api will even boot.

`k3d cluster stop atlas` stops the same containers and keeps all of it. For the
implement → test → stop → implement loop, stopping is what you want every time.

So `cluster.sh down` is the right tool for exactly two jobs: a corrupted cluster, and a
deliberate clean-slate rebuild. Both are rare, and both deserve to be asked for explicitly.

## Steps

1. **Warn if anything looks unfinished.** Before stopping, check for work in flight that the
   shutdown would strand:
   - resources mid-pipeline: `kubectl get pods -n atlas-dev` for a running `atlas-ingestion`
     job, or ask the api for versions still in `READING`/`BUILDING`
   - a `deploy-dev` run in progress in `atlas-infra`

   Not blockers — Redis Streams redeliver and the sweepers reclaim — but mention it rather
   than pulling the floor out silently.

2. **Stop the cluster.**

   ```
   k3d cluster stop atlas
   ```

   Idempotent: stopping an already-stopped cluster is a no-op. Use Git Bash or PowerShell —
   `bash` from PowerShell is WSL and cannot see the Windows k3d binary.

3. **If `$ARGUMENTS` is `docker`** — quit Docker Desktop too. This is the real memory win: the
   WSL VM keeps its allocation while Docker runs, whether or not containers are up.

   ```
   Stop-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue
   ```

   `wsl --shutdown` also works and is more thorough, but it takes down **every** WSL distro,
   not just Docker's — say so if the user has others running.

4. **If `$ARGUMENTS` is `delete`** — confirm first, in one line, that this means a full
   redeploy plus re-applying secrets. On a clear yes:

   ```
   bash atlas-infra/scripts/cluster.sh down
   ```

5. **Confirm and report.** `k3d cluster list` should show the cluster stopped (`0/1` servers)
   or absent after a delete. State which mode ran and exactly what it will take to come back,
   so nobody is surprised later.

## Do not

- Do not `wsl --shutdown` as the default — it is heavier than asked for and takes unrelated
  distros with it.
- Do not delete the k3d **registry** separately; `cluster.sh down` already handles it, and
  removing it alone leaves a half-configured cluster that fails confusingly on the next deploy.
- Do not `kubectl delete` namespaces or workloads to "free memory". Stopping the cluster frees
  all of it, and deleting workloads means a redeploy for no gain.

# Ephemeral VM Recipes

## Summary

Orca should support a third remote execution model for users who want a fresh cloud VM or
sandbox for a single workspace/worktree. This is separate from the existing long-lived host
models:

- **SSH hosts**: user-managed machines that can host many projects and worktrees.
- **Remote Orca servers**: long-lived paired Orca runtimes that can host many projects and
  worktrees.
- **Ephemeral VM recipes**: project-scoped local scripts that provision a one-off remote
  environment for one workspace/worktree lifecycle.

The goal is to unlock power-user cloud workflows without making Orca responsible for managing
cloud infrastructure.

## Philosophy

Orca is a thin wrapper around user-owned tools. We do not manage users' CLI agents for them, and
we should apply the same principle to cloud VMs and sandboxes.

Orca should provide the interface and orchestration surface:

- let users define project-scoped VM recipes
- run the selected recipe locally
- capture logs and status
- pair with the `orca serve` instance produced by the recipe
- create the remote workspace through the normal remote-server APIs

The recipe owns provider-specific behavior:

- authenticating with cloud providers
- provisioning the VM/sandbox
- preparing images, dependencies, repo clones, credentials, and CLIs
- installing or locating `orca`
- starting `orca serve`
- exposing the server over a reachable host/port
- returning a pairing URL Orca can use

This intentionally prioritizes openness and flexibility over provider-specific abstractions.

## Core Model

A VM recipe is a project-scoped command configured in the repo's `orca.yaml`.

The command runs locally on the user's computer. It may call any provider CLI or script the user
has installed, such as Vercel Sandbox, E2B, Docker-like image tooling, custom cloud scripts, or
internal infrastructure commands.

The command provisions the remote environment, starts `orca serve` inside it, and returns enough
information for the local Orca client to pair with that server. Once paired, Orca controls the
remote runtime like any other remote Orca server.

There is no local worktree in this flow. The workspace/worktree is created remotely after pairing.

## Example Shape

The exact `orca.yaml` syntax is still open. A minimal first version could look like this:

```yaml
vmRecipes:
  - id: vercel-sandbox
    name: Vercel Sandbox
    command: ./scripts/orca-vm/vercel-sandbox.sh

  - id: e2b
    name: E2B
    command: ./scripts/orca-vm/e2b.sh
```

The command should run from the repo root.

A more structured, GitHub Actions-like syntax could be considered later, but the first version
should avoid becoming a workflow engine unless Orca needs step-level logs, retries, environment
interpolation, or reusable blocks.

## Recipe Contract

The exact stdout/stderr parsing is an implementation detail. The only hard requirement is that
Orca can pair with the `orca serve` instance started by the recipe.

Conceptually:

1. User selects a VM recipe while creating a workspace for a project.
2. Orca runs the recipe locally.
3. The recipe provisions and prepares the remote VM/sandbox.
4. The recipe starts `orca serve` in that environment.
5. The recipe returns a reachable pairing URL or equivalent pairing data.
6. Orca pairs with that server.
7. Orca creates the workspace/worktree remotely using normal remote-server APIs.

For v1, recipes may not need any input from Orca. Because the recipe is project-scoped and the
paired server is controlled by Orca after pairing, the client can provide workspace details after
the connection is established.

Optional context environment variables can be considered later, but should not be required for the
initial model.

## Networking

Networking is provider-specific and belongs to the recipe.

The recipe must ensure the pairing URL is reachable from the local Orca client. This matters
because many providers have different internal and external addresses.

For example, a VM may run `orca serve` on port `6767` internally, while the provider exposes it as
`https://sandbox-12345.provider.dev`.

The recipe is responsible for aligning:

- the address and port `orca serve` binds to inside the VM
- the provider's exposed public URL or tunnel URL
- the pairing URL returned to Orca

In practice, `orca serve` likely needs a way to separate bind address from advertised pairing
address, such as:

```bash
orca serve --host 0.0.0.0 --port 6767 --pairing-address https://sandbox-12345.provider.dev
```

Names and flags are illustrative.

### Port Conflicts

Multiple ephemeral VMs should not conflict if each VM has its own network namespace and provider
issued URL. It is fine for many VMs to run `orca serve` on the same internal port if each VM has a
distinct external address.

Conflicts are mainly a risk when a provider CLI exposes remote ports through local tunnels, such
as mapping every VM to `localhost:6767`. In that case, the recipe must allocate unique local ports
or use provider-native unique URLs.

Orca should document this clearly, but should not manage provider-specific port allocation.

## Lifecycle

Ephemeral VM recipes are intended to create runtimes with a 1:1 relationship to a workspace or
worktree.

The paired runtime should be distinguishable from manually saved remote servers. Even though the
connection is technically a regular Orca server, Orca should track metadata such as:

- recipe id
- project id
- workspace/worktree id
- creation time
- ownership/lifecycle kind

This lets the UI treat recipe-created runtimes differently from long-lived remote servers.

Cleanup should be considered separately. A cleanup hook is likely useful, but setup and pairing
should be solved first.

Potential future cleanup shape:

```yaml
vmRecipes:
  - id: vercel-sandbox
    name: Vercel Sandbox
    command: ./scripts/orca-vm/start-vercel.sh
    cleanup: ./scripts/orca-vm/stop-vercel.sh
```

The cleanup hook would still be user-owned provider logic.

## Security And Trust

Recipes execute repo-controlled code locally. Orca should treat this with the same caution as repo
setup scripts.

Expected UX requirements:

- clear confirmation before running an untrusted recipe
- visible command/log output
- cancellation while provisioning is running
- clear failure state when no pairing URL is produced or pairing fails

## What Orca Owns

Orca owns:

- reading project-scoped recipe definitions from `orca.yaml`
- presenting recipe choices during workspace creation
- running the selected local command
- showing progress, logs, cancellation, and errors
- extracting or receiving pairing information
- pairing with the remote `orca serve`
- creating the remote workspace after pairing
- marking the runtime as recipe/workspace-owned

## What The Recipe Owns

The recipe owns:

- cloud provider choice
- cloud credentials and auth
- VM/sandbox provisioning
- image/snapshot selection
- dependency setup
- repo availability on the remote machine
- `orca` installation on the remote machine
- starting `orca serve`
- provider port exposure and networking
- optional cleanup behavior

## Open Questions

- What should the final recipe output format be: pairing URL in stdout, last line only, JSON, or
  another structured event?
- Should recipe-created runtimes appear in the normal remote-server list, a workspace-owned host
  list, or both?
- Should Orca support a teardown hook in v1?
- Should Orca pass optional context environment variables later, such as project id or requested
  workspace name?
- Should recipes be allowed to define display metadata, icons, descriptions, or warnings?
- How should recipe trust/approval reuse the existing setup-script trust model?

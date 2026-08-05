# Docker deployment

Release images are published for `linux/amd64` and `linux/arm64` at
`ghcr.io/gisenberg/wmux`. The Compose stack can pull one of those images or
build directly from a normal wmux checkout. It runs as the unprivileged `node`
user and stores wmux state, generated auth tokens, settings, and durable session
metadata in the `wmux-data` volume.

## Start

From the repository root:

```bash
cp deploy/docker/.env.example deploy/docker/.env
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml pull
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --no-build
```

Use an immutable version tag for normal deployments. The moving `0.1` and
`latest` tags are also published. To build the checkout instead:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --build
```

The published port defaults to `127.0.0.1:3478`, suitable for a reverse proxy
on the Docker host. Follow startup and token output with:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml logs -f wmux
```

For direct access over a private network, set `WMUX_PUBLISH_HOST` to one
specific Tailscale or RFC1918 address and set `WMUX_PUBLIC_URL` to the URL at
that address. If managed remote machines need a different private route for
staged helpers and hooks, set `WMUX_HELPER_URL` to that reachable callback URL;
browser links continue to use `WMUX_PUBLIC_URL`.
When a reverse proxy or non-`*.ts.net` DNS name is used, set the same reachable
`WMUX_PUBLIC_URL` and add the hostname to `WMUX_ALLOWED_HOSTS`. The proxy must
forward WebSocket upgrades for `/ws/*`.

For features that resolve a caller from forwarded headers, such as dynamic host
registration in builds that include it, set `WMUX_TRUSTED_PROXIES` to the
proxy's exact IP as observed by wmux inside the container. With a proxy on the
Docker host this is often the container network's gateway, not the host address
used by clients. Inspect the supplied Compose network after it exists:

```bash
docker network inspect "${COMPOSE_PROJECT_NAME:-wmux}_default" \
  --format '{{(index .IPAM.Config 0).Gateway}}'
```

Use that result only after confirming the proxy reaches wmux through the
published port on that bridge. Re-check it whenever the Compose network is
deleted or recreated because Docker may allocate a different subnet. Do not use
a wildcard, hostname, or CIDR.

The entrypoint rejects wildcard, public, and non-IP `WMUX_PUBLISH_HOST` values
before wmux starts. Docker creates its port-forwarding rule before container
startup, so an invalid setting may briefly leave a rule with no listening wmux
process; correct the value and recreate the container. Do not bypass the image
entrypoint.

The supplied Compose file is the supported network boundary. A raw command such
as `docker run -p 3478:3478 ...` publishes on every host interface before the
container can inspect it. If raw Docker invocation is unavoidable, bind the
host side explicitly (for example `-p 127.0.0.1:3478:3478`) and pass the same
address as `WMUX_PUBLISH_HOST`.

`WMUX_HOST` is intentionally different from `WMUX_PUBLISH_HOST`. It controls
the address inside the container. Leave it unset in normal deployments: the
entrypoint selects a private IPv4 address on the container's default-route
interface. Explicit values are restricted to non-loopback Tailscale, RFC1918,
or IPv6 ULA addresses, preserving wmux's private-network bind policy. Loopback
is not valid for this internal bind because Docker's published traffic arrives
on the container network interface rather than container loopback.

## Machine and SSH configuration

No checkout configuration, `.env` file, SSH key, or wmux secret is copied into
the image. Without a mounted config, wmux exposes only its local container
machine. `wmux.config.example.json` is a generic remote-machine example and
uses `"localMachine": false` to suppress that container-local shell. Put the
real config outside the checkout, then add a second Compose file when remote
machines are needed:

```yaml
services:
  wmux:
    volumes:
      - /absolute/path/to/wmux.config.json:/home/node/.wmux/config.json:ro
      - /absolute/path/to/.ssh:/home/node/.ssh:ro
```

Pass both files to Compose, with the override last. Ensure the mounted files
are readable by the container's `node` user (UID 1000 in the standard image).
For a read-only SSH mount, pre-populate `known_hosts` so SSH never needs to
modify the directory. Keep credentials outside the checkout or in ignored
files. The repository root `.dockerignore` is a second boundary that excludes
common configuration, key, secret, state, and environment-file paths from the
build context.

The container's `local` machine is the container itself, not the Docker host.
SSH, `tmux`, `screen`, Python, curl, and file-type detection are installed for
the bundled helpers. Host devices and host-local graphical capture are not
implicitly exposed. Local tmux/screen processes live inside the container and
do not survive container restart or recreation; durable sessions on remote SSH
hosts remain owned by those hosts and can be reattached.

## Isolated candidate staging

`scripts/wmux-docker-staging` builds and exercises a committed candidate without
using the production Compose project, state, credentials, port, service, or
configuration. It may be run from any directory. Every invocation requires an
explicit private IPv4 publish address and an explicit high port; the wrapper
uses the same publish-address validator as the image and rejects port `3478`.
The staged wmux service has no host, Docker socket, SSH, or home-directory
mounts; the one-shot runner's two owner-local read-only inputs are described
below.

Choose a currently unused private address/port pair and keep the project name
for the lifetime of the staging installation:

```bash
export WMUX_STAGING_PUBLISH_HOST=100.64.0.10
export WMUX_STAGING_PUBLISH_PORT=13478
# Optional; the default is wmux-staging-<current-short-commit>.
export WMUX_STAGING_PROJECT=wmux-staging-candidate1

scripts/wmux-docker-staging up
scripts/wmux-docker-staging status
scripts/wmux-docker-staging smoke
scripts/wmux-docker-staging e2e
scripts/wmux-docker-staging url
scripts/wmux-docker-staging down
```

The address above is an example, not a default. `url` prints the test URL but
never its credential. `smoke` requires a healthy container, checks public
health and authenticated bootstrap responses, verifies the expected candidate
revision and `groupSidebarSessionsByHost: true`, and confirms the exact
ephemeral mounts, bridge network, read-only root, resource limits, logging,
dropped capabilities, and `no-new-privileges`. `e2e` first runs that smoke gate,
then records the visible container/network/start-state identity and runs the
existing browser-only desktop/mobile Chromium suite against a separate,
disposable service created from the visible candidate's exact recorded image
ID. The visible published service is not used as the fixture and is rechecked
unchanged after the run. Neither fixture nor runner publishes a port. It never
executes a browser or installs browser libraries on the Docker host.

The runner image is the official Playwright image pinned by manifest digest:
`mcr.microsoft.com/playwright@sha256:57b65fdc9ceabe0ef613124c7bbe2babcf9362c4d85e382fe3b03604e84b428a`.
That digest was selected for the repository's Playwright `1.61.0` dependency;
the policy rejects either image-digest drift or installed/locked Playwright
package-version drift. The image ID observed during the original Haswell
verification began `sha256:753f`; the manifest digest, rather than that
daemon-local image ID, is the durable identity.

Before any per-run credential is supplied, `e2e` revalidates the candidate and
copies the already validated owner-local build mirror into a new private
`<runtime>/e2e-context` without reading the shared `/mnt` worktree. It runs
`env -i npm ci --ignore-scripts --no-audit --no-fund` there with private npm
home/cache directories, validates source bytes/modes against the candidate,
pins the complete dependency-tree digest, and checks it again after execution.
The canonical checkout and detached provenance worktree never gain
`node_modules`. The E2E context and npm directories are removed after success,
failure, timeout, or a handled signal.

After dependency installation and image pulls finish, `e2e` creates a uniquely
named internal, non-attachable bridge labeled with the exact project, revision,
run ID, and network role. It creates a uniquely named fixture from the exact
recorded candidate image ID. The fixture has no host mount, volume, device, or
published port; it uses numeric UID/GID `1000:1000`, a read-only root, private
PID/IPC namespaces, dropped capabilities, `no-new-privileges`, no restart, 2
CPUs, a 1 GiB memory/swap ceiling, 512 PIDs, bounded tmpfs/shm, and one bounded
local log. Config, settings, state, timeline, attachments, and the local PTY
workspace all live in fresh tmpfs. The standard machine remains `Local`,
`kind: local`, `sessionBackend: pty`, `shell: /bin/sh`, and `cwd: /app`; the
standard keybinding override and shell-command tracking remain enabled.

The network and fixture are fully inspect-policy validated before start and
again while the bootstrap waits for credentials. A policy-owned bounded attach
supplies fresh per-run shared and registration credentials over stdin, waits for
health, scans startup output for either credential, and detaches without
signaling the service. A final healthy inspect gate completes before runner
creation. The runner URL is always `http://wmux-e2e-fixture:3478`; no host path
or published staging URL is used by the automated suite.

The runner is created before its credentials are delivered and its exact inspect
model is policy-checked: a revision-derived unique name and labels, numeric
non-root host-owner UID/GID, read-only root, all capabilities dropped,
`no-new-privileges`, Docker's default seccomp profile, default private PID and
explicit private IPC namespaces, no devices/ports/restart policy, 2 CPUs, 2 GiB
memory and matching memory-plus-swap limit, 512 PIDs, bounded tmpfs/shm, and a
single bounded local log. Its only host mounts are the E2E context and its fixed
bootstrap, both read-only and sourced below the owner-local runtime. It joins
the per-run internal bridge and receives only the non-secret internal fixture
URL and revision/runtime variables in container metadata.

The fixed bootstrap accepts exactly two line-delimited credentials on stdin
from a policy-owned Docker attach, exports them only in the runner process, and execs the
context's Playwright binary with one worker and fixed Chromium projects/output.
The fixture bootstrap follows the same stdin-only rule and writes its fixed
standard config into tmpfs before execing wmux. Tokens are never Docker
arguments, Config environment, labels, mounts, image
layers, or reported output. Attached output is captured to a mode-`600`, 4 MiB
bounded runtime log instead of the terminal. Both that stream and the bounded
`/tmp/e2e-results` archive are scanned for either credential before any result
is reported; a match is reported generically and the affected ephemeral
material is removed with the exact runner container. Fixture logs are scanned
as well. Cleanup targets the recorded runner ID, fixture ID, unique network ID,
and exact owner-local context on success, failure, timeout, and handled signals,
then proves each ID/name absent. Cleanup failure preserves the operation lock
and E2E evidence; there is no prune or project-wide deletion.

`up` verifies the launcher's bytes against committed `HEAD`, refuses tracked or
staged checkout changes, and has no dirty-tree override. It copies the pinned
commit's objects into a new owner-only bare repository without using a remote,
then creates a detached worktree below
`/mnt/storage/sw_projects/.worktrees/wmux/stage-<short-revision>-<run-id>` and
re-executes the committed launcher there. Canonical checkout attributes,
replace refs, filters, untracked files, and archive/tool environment cannot
alter this materialization. Every tracked path is compared to `git ls-tree`
mode/blob identity with no-filter hashing; gitlinks and absolute or escaping
symlinks are rejected. Before Docker selection, a policy helper copies only
those committed tracked files into an exclusive owner-only
`<runtime>/build-context` tree without invoking archive/copy tools. It preserves
executable and safe relative-symlink semantics, immediately repeats the exact
path/mode/blob validation against the isolated repository, and pins the tree
digest plus filesystem identity in protected metadata. Docker and Compose read
only that local mirror; the detached worktree remains the independently cleaned
and revalidated E2E source and provenance record. Candidate image identity,
build arguments, `WMUX_BUILD_REVISION`, and
OCI revision are verified on reuse or smoke. Remote Docker endpoints (including
SSH Docker contexts) are refused. The effective direct/sudo access mode, Docker
context, Unix endpoint, and engine ID are pinned at `up`; every later Docker
operation must match them. External object/worktree variables, hooks, fsmonitor,
`NODE_OPTIONS`, `TAR_OPTIONS`, inherited proxy variables, and
the caller's Docker configuration are excluded from provenance operations. The
Docker client uses a new empty owner-only config for every locked operation. Its
exact non-symlink location below the validated operation lock is revalidated
before cleanup; if sudo Docker populated it with root-owned Buildx state, the
same sudo authority removes only that ephemeral config tree before releasing the
lock. No broader runtime path is passed to privileged deletion. All standard
upper/lowercase proxy build arguments are explicitly empty.

The visible service's mode-`600` environment containing independently generated
shared and registration tokens is stored below the durable owner-local
`${XDG_STATE_HOME:-$HOME/.local/state}/wmux/docker-staging` hierarchy, never
`/tmp` or shared root-squashed storage. Override this with an absolute
owner-local, non-`/mnt` `WMUX_STAGING_RUNTIME_ROOT` when another approved
durable location is required; `e2e` rejects shared `/mnt` runtime paths.
When Docker access requires `sudo`, that override must be on a root-readable
local filesystem so root can read the empty `DOCKER_CONFIG`, protected Compose
metadata, and verified build mirror; the shared owner-only worktree is never a
Docker/Compose input. The directory and all staging secrets remain owner-only
(`0700` directories and `0600` files).
Every path component is owner/mode/symlink
validated, each project operation owns an exclusive lock, and metadata is
created once with exclusive no-follow semantics. A protected identity record
pins the isolated repository, detached worktree, Git administrative directory,
revision, and filesystem identities; a provisional record preserves paths when
materialization fails. After `up`, a second protected
record pins the exact container, network, and image IDs plus their expected
names. A stale lock after an
uncatchable process termination must be inspected before manual removal.
`config-path` prints only the protected file path. For unavoidable manual
browser testing, open that file only in a private,
non-recorded terminal and transfer the `WMUX_TOKEN` value directly to the wmux
authentication prompt; do not print it into logs, shell tracing, chat, or
command arguments. Automated smoke reads it without printing it or placing
token values in command arguments. Every `e2e` invocation creates a temporary
mode-`600` metadata file with fresh distinct 64-hex service and registration
credentials that are also checked distinct from both visible credentials. Only
policy-owned attach operations read them; verified exact cleanup removes the
file. Compose policy receives the
protected file path and validates distinct 64-hex secrets against the rendered
config stream. The committed Node smoke client disables redirects and bounds
connect, inactivity, total, header, and response-body consumption without
writing response files. As with any container environment
secret, Docker-daemon administrators can inspect it; access to the daemon and
the mode-`600` runtime file remains trusted staging-operator authority.

Staging uses only `docker-compose.staging.yml` and `Dockerfile` from the verified
local build mirror; it never reads those inputs from the detached worktree or
merges them with the production Compose file. Before build, the wrapper
consumes that entire effective model and rejects every non-allowlisted service,
build option/argument, environment key, mount, config, secret, namespace,
device, port, network, or logging option without writing or logging rendered
credentials. The service explicitly selects the `node` user, disables
privilege and restart, leaves PID mode at Docker's default private namespace,
uses an explicit private IPC namespace, a read-only root, drops
every capability, enables `no-new-privileges`, and bounds the container at 2
CPUs, 1 GiB memory with the memory-plus-swap ceiling also at 1 GiB, 512
processes, and three 10 MiB local log files.

The staged wmux service has no Docker volumes or host-backed mounts.
`/home/node/.wmux` is a
bounded 256 MiB tmpfs; `/tmp` and `/run` are bounded 64 MiB and 8 MiB no-exec
tmpfs mounts. All staging settings, workspaces, sessions, generated credentials,
and durable-shell state inside the container are intentionally lost whenever
the container is removed or recreated. The protected operator metadata outside
the container contains only staging lifecycle authority and candidate evidence.

The visible runtime bridge is one dedicated, non-attachable Compose bridge with Docker's
default outbound connectivity. Making it non-internal is a deliberate
compatibility tradeoff: Docker then realizes the exact private-IP published port
on hosts where an `internal` bridge leaves `NetworkSettings.Ports` null, but the
staging candidate can initiate outbound network connections. Never place SSH
keys, host or production configuration, production tokens, or other reusable
credentials in this container. The wrapper still permits exactly one bridge and
one private host/port binding, and live policy verifies the bridge driver,
non-internal/non-attachable flags, attached network, and realized port. Docker
image build networking remains under the Docker builder's normal policy.
Automated E2E never joins or mutates that bridge. Its disposable fixture and
runner share a separate per-run `internal` bridge, so they can reach each other
but have no Docker-routed egress after dependency and image pulls complete.

Resource discovery checks project labels and exact container/network names
independently and also refuses any project-labeled or legacy exact-name volume.
Existing unlabeled collisions are never adopted. Before every operation, the
recorded IDs and full live container/network policy are revalidated. `down`
repeats that audit immediately before exact `--remove-orphans`, verifies the
recorded container/network IDs and every matching name/label are gone, confirms
the recorded candidate image remains unchanged, and only then removes runtime
metadata (including the local build mirror), the isolated repository, and its
detached worktree. Worktree removal
uses only that isolated repository's `git worktree remove` after filesystem
identity and exact-tree validation; identity failure preserves the evidence. If
metadata is missing while matching
resources exist, it fails loudly instead of claiming success. No prune, volume
deletion, or direct broad resource deletion is performed. The candidate image
intentionally remains in the local image cache.
The same audited removal runs when provisioning or startup stops before
`live.env` exists; provision/identity mismatch retains the incomplete runtime
and worktree for inspection rather than deleting either path.
If the checkout revision changes and the default project name was used, set
`WMUX_STAGING_PROJECT` to the original name before teardown.

Passing `smoke`/`e2e` demonstrates the candidate image and isolated Docker
installation, not production-system parity. Shells and tmux/screen sessions are
container-local. The method does not validate systemd supervision, native
POSIX/Windows agents, host SSH inventories, MediaMTX/capture, or host devices.
Visible-candidate-untouched evidence consists of the pre/post exact
container/network/start-state snapshot plus the disposable fixture/runner's
distinct run labels and internal network. Production isolation remains the
staging project's dedicated non-internal bridge and ephemeral mounts reported
by `smoke`, plus the wrapper's absence of production service/config/state
operations; teardown targets only recorded staging or per-run IDs.

## Operations

The image health check calls the unauthenticated `/api/health` endpoint on the
selected internal bind address, using HTTPS when native wmux TLS certificate
and key variables are present. Inspect it with `docker compose ps`.

To print the generated shared token or configure browser login credentials:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml exec wmux cat /home/node/.wmux/token
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml exec wmux \
  node scripts/wmux-set-password --username you
```

Pull and restart when following a published tag:

```bash
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml pull
WMUX_IMAGE=ghcr.io/gisenberg/wmux:0.1.2 \
  docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --no-build
```

Rebuild and restart after updating a source checkout:

```bash
docker compose --env-file deploy/docker/.env \
  -f deploy/docker/docker-compose.yml up -d --build
```

Tagged releases also carry OCI source, version, revision, and license labels,
plus an SBOM and registry-backed build-provenance attestation. A Gitea Actions
mirror can copy the exact GHCR manifest using
`.gitea/workflows/release-container.yml`; configure the repository variables
`CONTAINER_REGISTRY` and `CONTAINER_USERNAME` and the `REGISTRY_TOKEN` secret
on that Gitea instance. The registry must use trusted HTTPS.

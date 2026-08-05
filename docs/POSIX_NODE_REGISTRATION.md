# POSIX Session Agent Setup

The native POSIX session agent gives Linux and macOS machines restart-durable wmux panes without requiring `tmux` or `screen`.
It runs independently under systemd user services or launchd, owns each pane's PTY and replay buffer, supervises on-demand view-only capture, and implements the same generated HTTP contract as the Windows agent.

## Security boundary

Bind the listener only to loopback, an exact Tailscale address, or an exact private-network address.
For a remote agent, restrict the configured TCP port at the host firewall to the wmux server's exact internal address.
The bearer token grants process creation, terminal input, replay, resize, file staging, and process deletion authority.
Store it only in owner-readable configuration and never place it in a tracked file or command argument.

## Agent configuration

Create `~/.wmux/session-agent.json` with mode `0600`.
The listener defaults to loopback port `3481`, the backend defaults to a native PTY, and registration heartbeat ownership defaults to enabled when the registration files exist.

```json
{
  "host": "127.0.0.1",
  "port": 3481,
  "token": "replace-with-a-long-random-token",
  "backend": "pty",
  "streamOwner": true,
  "streamEnabled": true
}
```

Use the machine's exact Tailscale or private address instead of loopback when a remote wmux server must connect directly.
Generate a token without passing it on a process command line:

```bash
python3 -c 'import secrets; print(secrets.token_urlsafe(32))'
chmod 600 ~/.wmux/session-agent.json
```

## Linux supervision

From a wmux checkout on the target machine, run:

```bash
scripts/install-session-agent-service.sh
systemctl --user status wmux-session-agent.service
```

The installer links the repository-owned agent and capture worker into `~/.local/bin`, installs one restarting user service, and retires the standalone `wmux-heartbeat` and `wmux-stream-agent` services.
Enable user lingering if the agent must remain available while the target account is logged out:

```bash
loginctl enable-linger "$USER"
```

## macOS supervision

From a wmux checkout on the target machine, run:

```bash
scripts/install-session-agent-service.sh
launchctl print "gui/$(id -u)/io.wmux.session-agent"
```

The installer creates `~/Library/LaunchAgents/io.wmux.session-agent.plist` with `RunAtLoad` and `KeepAlive`.
It also prepares `~/.wmux/WmuxStreamAgent.app` as the Screen Recording identity and retires the standalone capture LaunchAgent.
The agent runs only while that user's graphical login domain exists.

## View-only streaming

Provision owner-only `~/.wmux/stream-agent.json`, install FFmpeg, and use the same session-agent installer shown above.
The native agent starts and reconnects the capture worker, while the worker starts FFmpeg only while a browser holds a stream lease.
On macOS, grant Screen Recording permission to `~/.wmux/WmuxStreamAgent.app`.
See [STREAMING.md](STREAMING.md) for the shared configuration, MediaMTX setup, and platform limitations.

## Static wmux configuration

Add the target to the wmux server's ignored `wmux.config.json`:

```json
{
  "id": "linux-agent-box",
  "name": "Linux Agent Box",
  "kind": "ssh",
  "platform": "linux",
  "host": "100.64.0.21",
  "user": "operator",
  "sessionBackend": "agent",
  "agentPort": 3481,
  "agentToken": "replace-with-the-agent-token"
}
```

Use `kind: "local"` and `agentUrl: "http://127.0.0.1:3481"` when the agent runs on the wmux server itself.
When a remote SSH `host` is a DNS name, set `agentUrl` to the agent's explicit private IPv4 origin and keep `agentPort` aligned with it.
Set `platform: "mac"` for a macOS target so release health compares against the macOS-suffixed wmux version.

## Dynamic registration

Provision the existing owner-only registration files when the target should appear through heartbeat discovery:

```text
~/.wmux/url
~/.wmux/registration-token
~/.wmux/heartbeat.json
```

The heartbeat machine must use `kind: "ssh"` and `sessionBackend: "agent"`.
The agent injects its live `agentPort` and private `agentToken` into the outbound heartbeat, and wmux removes that token from every browser and status response.

```json
{
  "machine": {
    "id": "linux-agent-box",
    "name": "Linux Agent Box",
    "kind": "ssh",
    "user": "operator",
    "sessionBackend": "agent"
  },
  "ttlMs": 90000
}
```

The owning session agent replaces the standalone heartbeat timer.
The one-shot `scripts/wmux-heartbeat --once` command remains useful for diagnosing registration files and server reachability.

## Validation

From the target:

```bash
curl http://127.0.0.1:3481/health
```

From the wmux server, query the exact private address and confirm the response reports the expected release and generated protocol version.
When streaming is configured, confirm the health response contains `stream.configured: true` and that `stream.running` returns after intentionally terminating the capture worker.
Create an agent-backed pane, run a command, restart only `wmux.service`, and confirm the pane reattaches with the process and terminal state intact.
Closing the pane explicitly must remove the corresponding agent session.

The agent process itself is the durability boundary.
An unexpected or forced session-agent restart terminates its owned processes.

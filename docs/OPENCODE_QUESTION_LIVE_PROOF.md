# OpenCode structured-question live proof

This runbook executes the HARD SERVER PROOF GATE defined in
[OpenCode question compatibility](OPENCODE_QUESTION_COMPATIBILITY.md#automated-and-live-proof-boundary).
It is deliberately separate from fixture and integration tests. A passing
`npm run check`, an unaccepted deployment, or a TUI that happens to traverse
that deployment is not live-gate evidence.

## Current gate status

**PENDING — no accepted live proof is recorded.**

Do not change this status until an explicitly accepted target runs the proof
below against the exact clean repository revision being evaluated. Any existing
question-enabled deployment remains unaccepted until it satisfies this gate.

## Safety and prerequisites

The proof is an external mutation: it sends one synthetic prompt to an already
running, real, top-level OpenCode TUI and submits synthetic choices through the
browser question shelf. Obtain explicit authorization for the deployment target
and proof run before proceeding. The runner does not deploy, restart services,
install hooks, create panes, or change wmux/OpenCode configuration.

Before running:

1. Commit the candidate and use a clean proof-runner checkout at that exact
   revision. For a systemd checkout deployment, authenticated
   `/api/provenance` binds the canonical executing `src/server/index.ts`, startup
   Git root/identity, and current working tree to one worktree, then recomputes
   live Git revision/cleanliness at the beginning and end of each proof. The
   endpoint requires the source-loaded development runtime used by the systemd
   service; mixed roots, ignored/stale built artifacts, unknown or dirty checkouts,
   environment-asserted revisions, and non-Git images fail this gate. The
   current Docker packaging therefore cannot be an accepted target.
2. Deploy that same clean revision to the explicitly accepted target through the
   normal deployment workflow. Install the generated OpenCode plugin, confirm
   `wmux-hooks status` reports `opencodeParity: true`, and restart the target
   OpenCode process so it loads the plugin. These are deployment actions and are
   outside this repository-only runbook step until authorized.
3. Use a root/user workspace containing the real top-level OpenCode TUI. Do not
   use an agent-owned one-shot or child workspace. Record its workspace, tab, and
   pane IDs without placing them in tracked files.
4. Provision a strong browser-capable test token only in the runner process
   environment. Do not put credentials in shell history, command arguments,
   tracked files, screenshots, or proof records.
5. Use `shared-or-login` browser authentication for this gate. The runner checks
   `/api/auth-info` and fails closed on `login-only`; an automation credential
   cannot substitute for the browser authority required to answer.

The accepted target label must be a sanitized non-host label such as
`accepted-staging-2026-08`. The target decision must also record the SHA-256
digest of the exact accepted URL origin. The runner recomputes that digest from
`WMUX_E2E_BASE_URL` and fails on a mismatch. The ignored proof artifact records
the label and digest, but omits the raw URL, hostname, pane/session/request IDs,
and answers.

## Run

Set these variables in the authorized runner environment, then execute the
dedicated gate. The command fails closed if any variable is absent, the local
checkout is dirty, authenticated `/api/provenance` does not report the exact
clean revision, the workspace is not root/user-owned, or any gate assertion
fails. The wrapper removes stale evidence before Playwright configuration or
browser startup, assigns a fresh invocation ID, and removes evidence on failure.

```bash
export WMUX_E2E_BASE_URL='https://accepted-private-wmux-origin'
export WMUX_E2E_TOKEN="$(<path-to-owner-only-test-token)"
export WMUX_QUESTION_PROOF_ACCEPTED_TARGET='accepted-staging-2026-08'
export WMUX_QUESTION_PROOF_ACCEPTED_ORIGIN_SHA256='<digest from the accepted target decision>'
export WMUX_QUESTION_PROOF_EXPECTED_REVISION="$(git rev-parse HEAD)"
export WMUX_QUESTION_PROOF_WORKSPACE_ID='ws_...'
export WMUX_QUESTION_PROOF_TAB_ID='tab_...'
export WMUX_QUESTION_PROOF_PANE_ID='pane_...'
npm run proof:opencode-questions
```

The Playwright profile disables traces, screenshots, and video. The test sends
one prompt that directs OpenCode to issue one three-part interactive request:
single-select, multi-select, and custom. It then:

- submits synthetic answers through the rendered desktop shelf;
- requires the answer HTTP result to be `delivered`, which is emitted only after
  the broker classifies the typed SDK reply result;
- requires the durable/public request to converge to `answered` with `user`
  resolution;
- requires a unique continuation marker from the same TUI session;
- proxies the browser's full-duplex target pane WebSocket and also arms a
  bounded, user-only, in-memory monitor at `SessionManager`'s actual backend
  write boundary. After the question appears, both must show that no user input
  message, answer bytes, or synthetic CR/LF reaches pane input.
  Protocol-generated terminal response writes are counted separately; the
  monitor derives the fixed synthetic answer set from the proof nonce and never
  persists or returns answer content. Incremental byte matchers span backend
  write boundaries and ignore `terminalResponse` classification, so fragmented
  or disguised answer bytes still fail the gate.
- verifies authenticated source-runtime provenance before the prompt and again
  after final convergence, binding the pass to one exact clean revision.

## Evidence and acceptance record

On success the runner writes owner-only, ignored evidence to:

```text
test-results/opencode-question-live-proof.json
```

The artifact contains only a random proof invocation ID, accepted target label
and origin digest, exact repository/server revision, timestamps, boolean gate
outcomes, final public state/resolution, and pane-input counters. It never
contains raw answers, the target URL, hostnames, or workspace/tab/pane/session/
request IDs. A failed run writes no pass artifact.

After reviewing a successful artifact, record acceptance by replacing the
pending status above with the accepted target label, exact revision, UTC proof
time, and artifact schema version. Do not paste the target URL, private machine
identity, runtime IDs, terminal output, request bodies, or answers into this
document or an issue/PR. Preserve the untracked JSON only in an approved
owner-only evidence location if longer retention is required.

## Failure handling

- unknown or dirty provenance: redeploy a clean committed candidate; do not
  waive the identity check.
- No shelf request: verify plugin parity/status and that a fresh top-level
  OpenCode process is running in the selected pane. Status diagnostics are
  intentionally answer-free.
- Any non-`delivered` result, missing continuation marker, non-`answered` final
  state, user pane-input message, answer-byte match, or synthetic Enter: the hard
  gate fails. Preserve only sanitized diagnostics, repair in the repository, and
  rerun the entire live gate after a newly accepted deployment.
- Never infer acceptance from fixture tests or a partial live run.

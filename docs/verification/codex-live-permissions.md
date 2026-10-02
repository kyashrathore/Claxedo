# Codex permission changes during an active turn

Verified 2026-10-02. Immediate Full access remains unimplemented: the native app-server active-turn API does not support changing its permission snapshot.

## Observed flow

Selecting Full access updates the stored session configuration. `createCodexConfig().setPermissionMode()` in `packages/harness/src/transports/codex-app-server/config.ts` stores the mode in `entry.start.config`. The next turn sends `approvalPolicy: never` and the danger-full-access sandbox. The running turn retains the policy selected at its start. Therefore command approvals can continue after the UI selection.

For the reported session, the turn began at 10:17:35 UTC with on-request/workspace-write; Full access was stored at 10:37:32 UTC. The native thread was `01a0fc1e-4ff1-7a11-8ab6-0e62e78746e4`.

## Native API evidence

An attempted integration called `thread/settings/update`, waited for `thread/settings/updated`, and only then published the selection. Real execution disproved that acknowledgement as evidence of active-turn permissions, so the integration and its immediate-effect metadata were removed.

The diagnostic uses a real Codex process with a scripted model boundary. While a turn is held, it sends native thread settings and receives acknowledgement of never/dangerFullAccess. The next command batch in that same turn still cannot write outside its workspace. A new turn using Full access successfully writes the identical file. The target is in the repository, outside the temporary session workspace; using a temporary output path would incorrectly test a sandbox exemption.

`turn/settings/update` rejects permission fields in both the pinned 0.159.2 and latest 0.160.0 protocol. `thread/resume` also ignores overrides when rejoining a running thread.

Primary source: [Codex 0.160.0 active-turn settings tests](https://github.com/openai/codex/blob/rust-v0.160.0/codex-rs/app-server/tests/suite/v2/turn_settings_update.rs). The tests explicitly reject unsupported fields including approvalPolicy, sandboxPolicy and permissions.

## Reproduction and checks

From `packages/harness`:

```sh
/Users/yashvardhansingh/.bun/bin/bun test ../../docs/verification/codex-live-permissions.test.ts
```

Result: 1 passed, 0 failed, 6 assertions. This verifies the existing limitation and successful application on the next turn; it does not claim immediate application is fixed.

Earlier proposed immediate-effect acceptance tests failed: require_escalated still prompted after native acknowledgement, and the true outside-workspace write failed with ENOENT. Harness and application typechecks passed during the attempted integration. Architecture ratchets passed (26 tests). The full H3 flow timed out before the first Claude permission event and did not reach Codex. Harness domain size checks have six pre-existing over-budget domains; no ceilings were changed.

## Unmet requirement and owner

Unmet: change the sandbox and approval policy of an already running Codex turn immediately, without interrupting or synthesizing a new turn.

Owner: OpenAI Codex app-server/core. Extend the active-turn settings protocol to accept permission changes, validate them against server constraints, update the active execution/approval context, and acknowledge effective application. Define pending-approval behavior and test tightening, relaxing, failure, isolation and recovery. After that support exists, Claxedo can connect its canonical configuration setter to that API and publish effective state after acknowledgement.

A stop followed by a new turn uses the selected Full access today. Automatically interrupting and restarting would change the requested semantics and is not implemented as a substitute.

# 09 — Auth, accounts, remote workspaces

## Scope
Clerk sign-in, account state in the shell, hosted/user-hosted workspaces,
relay transport, telemetry consent.

## Current implementation
- Desktop account: `packages/claxedo-desktop/src/main/account/**` (lazy
  chunk; Electron main owns the account, renderer follows AccountPort —
  `platform/account/account-provider.tsx`).
- Hosted contributions activate on signed state
  (`app/composition/product-contributions.ts`, `initClaxedo` notes).
- Relay/remote: `platform/runtime/agent/workspace-relay-connection.ts`,
  workspace gates (fire-and-fail class), `features/workspaces/data/**`.
- Telemetry: PostHog renderer-side (`platform/telemetry/analytics.ts`),
  desktop-main fatal capture (`main/telemetry.ts`, two opt-ins).

## Target design
- Auth: system-browser OAuth with loopback callback (native-app standard)
  OR wry WebView for the embedded flow — spike BOTH against Clerk's native
  constraints; tokens in OS keychain (keyring crate).
- AccountPort becomes a Rust trait with the same states; hosted
  contributions = feature-gated modules activated on signed.
- Relay client in the transport crate (08); same backoff/gating semantics.

## Kill criterion
If Clerk cannot issue/refresh sessions outside a browser context acceptably
(no embedded-webview policy), the auth flow stays system-browser+loopback —
verify token refresh longevity in the spike before Phase 4 commits.

# Reload and first paint, 20 October 2026

A reload of an open session drew its text 797 ms after the navigation on the rig's india-staging profile, and a cold boot painted nothing for half a second. Two changes move both.

## The reload's session reads leave with the main chunk

On a warm reload the session's first read (`/session/<id>/outline?…`) and open view (`/session/<id>?view=open`) left at 346 ms, after the session read and the rail's catalog had answered (both preloaded by the shell's `Link` header and back at about 330 ms) and the shell had mounted the session behind the sign-in gate. They need none of that: the relay authorizes them by the Runtime Access Token the tab already keeps in its `sessionStorage`, and the workspace and session ids are in the URL.

Now the server scope reads the session the URL names (`routedSession`, `src/app.tsx`) and the session stores preload those two reads as they are created (`sessions.preload` → `Transport.preloadRuntime` → `Relay.preload`), under the link this tab keeps for the session, else for its workspace. A preload mints nothing, so a tab without a kept link sends nothing; the reader's own fetch of the same path under the same scope later takes the response once. Authorization stays the relay's: a parked 401 renews the link and resends, as the reader's read would, a lease that is not ready answers 401 at the relay's resolver, so a preload never wakes a sandbox, and the sign-in gate still decides from the session read. The reads now leave at 127 ms. `src/server/README.md` (Transport) and `src/session/README.md` hold the contract.

## The startup frame paints with the document

The shell's startup frame, its outline drawn in CSS gradients on an empty `#root`, lived in the 45 kB main stylesheet, which the head linked and so blocked every paint until it downloaded: 500 ms into a cold boot. The frame is now its own sheet (`src/shell/styles/startup.css`), inlined into the shell document's head, and the document links its stylesheets after `#root`, with a `rel=preload as=style` for each left in the head (`vite.web-document.ts`). Chromium holds the paint only of what follows a body stylesheet, so the frame paints as the document arrives, and the app's module script still waits for every stylesheet. Without the head preloads Chromium asked for the second body stylesheet only once the first had loaded, 135 ms later.

First contentful paint does not count gradients, so the rig now records first paint (`fp`) and cumulative layout shift (`cls`) beside it.

## Measured

`bun run --cwd packages/claxedo-app e2e:perf-web --reps=3 --profile=india-staging` (100 ms RTT to static, 300 ms to the API, 10 Mbps down, the e2e front over HTTP/2), p50 of 3, same host within ten minutes: dev `74370a87cf` with the rig's `fp` and `cls` columns in one worktree against this branch in another. The host was shared with another lane (load 20 to 26).

| scenario | headline before → after | fp | fcp | lcp | cls | requests, kB, waves |
|---|---|---|---|---|---|---|
| warm-session/reload, session text | 796 → 569 | 140 → 152 | 372 → 368 | 812 → 588 | 0.029 → 0.029 | 53, 55.5 → 57.3, 3 |
| cold-session/boot, session text | 1673 → 1664 | 508 → 180 | 832 → 812 | 1708 → 1696 | 0.029 → 0.029 | 54, 791.4 → 793.8, 3 |
| cold-root/boot, rail | 799 → 800 | 500 → 176 | 828 → 836 | 828 → 836 | 0 → 0 | 41, 642.1 → 644.4, 3 |
| open-session/press, session text | 454 → 448 | | | | | 7 |
| signed-out-login/boot, form | 363 → 366 | 316 → 312 | 372 → 368 | 372 → 368 | 0.009 → 0.009 | 10, 152.9 → 152.8, 3 |

The documents grew 1.4 kB for the inlined frame and the preload links. The warm reload's first paint was already early, since its stylesheets come from the memory cache.

## What bounds them now

- **Warm reload text** is the relay read: it leaves at 127 ms and answers about 420 ms later, of which 300 ms is the profile's API latency and most of the rest is the relay's own authorization. The relay asks the control plane whether the token is revoked and where the workspace is (`isRuntimeAccessTokenActive`, `resolveTarget`, each cached 10 s, `packages/workspace-relay`). In the e2e stack the relay reaches the control plane through the shaped front, so on the rig each of those round trips also pays the profile's 200 ms API delay: a relay read answers in about 210 ms when both are cached, 420 when one round trip is needed and 630 when two run one after the other, which one rep in three of a warm reload hit before and after this change (775 ms). Unshaped, the same reads take 11 to 14 ms. In production that hop is Worker to Worker, so the rig overstates it; it is still a control-plane round trip on every reload more than 10 s after the last read.
- **Warm reload first contentful paint** (368 ms) is the shell, which stays behind the sign-in gate until the session read answers. Drawing it for the restoring user before that answer would change what a stale cookie shows and the scope the shell is keyed by (the user and their organization, which only the answer names), so it is not done here.
- **Cold boots** are bound by `main.js`: 306 kB Brotli over the profile's 10 Mbps arrives about 700 ms in, and the shell, the connection read (210 ms) and the relay reads (answering in 640 ms, on a connection of their own since they omit credentials, under a token minted a moment before) follow it.
- **Main thread** on a warm reload is 111 ms busy with no long task; between the reads' answer and the painted text there are about 20 ms, the largest single items a 3 ms markdown sanitize and 2.3 ms of the timeline's virtualizer measuring, so nothing on that path is worth taking out.

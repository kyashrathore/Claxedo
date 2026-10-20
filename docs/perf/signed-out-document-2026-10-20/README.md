# The signed-out document, 20 October 2026

A signed-out visitor's first page is the sign-in form: one heading, one line and a "Continue with GitHub" button. Until this change the edge answered a browser without the session cookie with the app shell, and the shell loaded the whole app (`main.js` 352 kB Brotli, the vendor chunks, the 49 kB stylesheet, then the codex icon sprite for the button's GitHub mark) before the app's sign-in gate drew the form. Pressing the button leaves the page for GitHub, and the return is a full navigation, so nothing of that app ever ran for the visitor.

## What changed

The build has a second document, `login.html`, with its own entry `src/login.tsx` and composition root `src/login-document.tsx`: the auth binding, the theme and the preferences the form draws under, and the same `LoginForm` the app's `/login` route renders (`src/auth/view/login.tsx`). The form takes a `LoginHost` from whichever document hosts it: the app's router, or the window, which replaces the URL with `/login` as the shell's gate does and leaves for `/` by a full navigation once an email sign-in settles. The document's head preloads its one read, `/api/auth/get-session`, so the read leaves with the document instead of after the entry evaluates.

The app Worker and the e2e front choose the document by one rule, `shellDocument` in `packages/claxedo-server/scripts/deploy/shell-document.ts`: a browser carrying the session cookie gets the shell with the boot reads preloaded on every route; without the cookie, `/` and `/login` get the signed-out document and every other route the shell as the assets serve it, whose gate still draws the auth screens with their own pages (`/invitations`, `/device`, `/oauth/consent`) and sends the rest to `/login`. The assets serve a document only at its own path (`html_handling = "none"`), so the Worker fetches `/login.html` by name and a signed-in browser at `/login` gets the single-page fallback, the shell. The deploy publishes the bootstrap and auth descriptor into both documents.

Two build changes made the second entry small. Rollup assigned every module reachable through a domain's `index.ts` to the chunk the two documents share, whether or not the signed-out entry used it: the consent and device screens, the server adapter's account modules with TanStack Query, the side panel controls and 44 kB of contract tables. The app's modules, the kit's and the contracts' do nothing at load but declare (`src/styles.ts`, the one import-only module, became `src/styles.css`), and `vite.cloud.config.ts` now says so (`treeshake.moduleSideEffects`), so an unused module is left out of the entry's graph. And `@solid-primitives` moved from the `vendor-ui` chunk to `vendor-solid`: the theme provider's one event-listener helper was pulling kobalte, floating-ui and motion (61 kB Brotli) behind it. The button's GitHub mark is drawn as an inline glyph, like the other brand marks, so no sprite is fetched. `vite.login-entry.test.ts` builds the entry and holds its chunk graph against the app behind the sign-in.

## Measured

`bun run --cwd packages/claxedo-app e2e:perf-web --reps=3 --profile=india-staging` (100 ms RTT to static, 300 ms to the API, 10 Mbps down; the e2e front over HTTP/2), p50 of 3, on the same host within the same ten minutes: dev `8ef0ffba59` in one worktree against this branch in another.

| scenario | before | after |
|---|---|---|
| signed-out-login/boot, form drawn | 945 ms, 14 requests, 656.5 kB, FCP 972 | 361 ms, 10 requests, 152.9 kB, FCP 372 |
| cold-root/boot, rail | 787 ms, 39 requests, 640.3 kB | 792 ms, 41 requests, 642.3 kB |
| cold-session/boot, session text | 1665 ms, 52 requests, 789.3 kB | 1662 ms, 54 requests, 791.5 kB |
| warm-session/reload, session text | 789 ms, 51 requests, 55.4 kB | 791 ms, 53 requests, 55.6 kB |
| open-session/press | 447 ms | 441 ms |

The signed-out boot's 153 kB are the document (5.8), the session read, four scripts (71.8: the entry, `vendor-solid`, `vendor-better-auth` and the 46 kB chunk the two documents share, which holds the theme, the kit's icon and the auth domain), two stylesheets (13.0) and the 46.7 kB artwork behind the form. Its floor is the session read: the form draws once the read answers, 300 ms after the document, and the entry evaluates before that.

The signed-in boots gain two requests, the shared chunk and its stylesheet, which the shell declares with its other preloads and which leave in the first wave; their bytes and times are unchanged within the run's noise.

## Not verified here

The Worker's document choice and the `html_handling` change are verified under Miniflare (`app-worker.test.ts`), not against a deployed Cloudflare origin. The desktop renderer inherits the tree-shaking declaration through `cloudConfig`; it typechecks and its entries are unchanged, but it was not rebuilt or measured.

/**
 * The SIGNED desktop renderer entry.
 *
 * One of two composition roots in this package. `local.tsx` is the unsigned
 * one, and the difference between them is not a flag: this file exists so that
 * the UNSIGNED bundle's import graph never reaches `@claxedo/app/auth`, and
 * therefore never reaches `platform/auth/auth-client.ts` or Clerk. A shared
 * entry with `if (signedBuild)` would still ship all of it — the module is in
 * the bundle whether or not the branch runs, which is the whole reason
 * `@claxedo/app`'s own entry was split first.
 *
 * Everything both products share lives in `./shell`, which imports no identity
 * surface at all. What is left here is exactly the identity seam: three port
 * bindings and a bearer.
 *
 * `renderer-entry-closure.guard.test.ts` measures those absences against the
 * real import graph rather than trusting this comment.
 */

// @refresh reload
import { configureAuthSession, getAuthToken, useAuth } from "@claxedo/app/auth"
import { configureApiRuntime } from "@/platform/api/api"
import { configureDesktopMachineRemoteAccess } from "@/platform/remote-access/machine-remote-access"

import { startDesktopRenderer } from "./shell"

/**
 * Bind the identity provider to the authenticated transport.
 *
 * `@claxedo/app`'s `platform/api/api.ts` used to import `getAuthToken` itself;
 * it now names a bearer source and each composition root supplies one, so the
 * transport can stay in `@claxedo/app` while the Clerk producer moves to
 * `@claxedo/cloud-app`. This renderer already holds `getAuthToken` for the
 * platform descriptor `./shell` builds — the same function, now also handed to
 * the transport explicitly.
 *
 * At module scope rather than in the `configureApiRuntime` call inside
 * `ServerGate`: that one runs during render, once the sidecar URL and password
 * are known, and anything that reached `authFetch` before then would lose the
 * bearer it has today.
 */
configureApiRuntime({ bearerToken: getAuthToken })

/**
 * Bind the identity provider to the app's canonical auth-session abstraction.
 *
 * Same reason as the bearer above, one seam over. `platform/auth/auth-session.ts`
 * used to `import { useAuth }` statically; because the shell's provider tree
 * calls `useAuthSession()` unconditionally, that put Clerk in the LOCAL bundle
 * too. It now keeps a type-only edge and takes the provider from whoever binds
 * one.
 *
 * This entry is the signed-in-capable build — it already holds `getAuthToken`
 * — so it binds the real provider. Without this line the desktop account menu
 * would report "Local workspace" forever with a green suite; `./local.tsx` and
 * the local browser entry are the composition roots that deliberately bind
 * nothing.
 *
 * At module scope, before render, for the same reason as `configureApiRuntime`.
 */
configureAuthSession(useAuth)

/**
 * Bind machine remote access to the Host Connector in Electron main.
 *
 * The desktop's sidecar is `@claxedo/local-server`, which serves none of
 * `/api/claxedo/remote-access/*` — those paths belong to the Host Connector
 * now, and the connector is in main because that is where the machine signing
 * key and the account credential live. So this renderer performs no request:
 * it names one of four operations over IPC.
 *
 * Without this line, "Enable remote access" posts to a route this product does
 * not serve. That is not hypothetical — it is what shipped, past a green suite,
 * because the transport was hardcoded in shared app code with nothing asserting
 * which product it belonged to.
 *
 * Bound only when the preload actually exposes the bridge. Nothing is bound in
 * its absence: an older preload under a newer renderer means the capability is
 * missing, and the panel reporting that is far better than a fallback that
 * quietly recreates the bug.
 *
 * `./local.tsx` deliberately does NOT bind it: enrolling a machine with the
 * Host Connector is an account-authorized operation, and the unsigned product
 * has no account. Unbound, the panel reports a capability this build does not
 * have — which is the honest answer, and the one the matrix in
 * `scripts/product-mode-contract.test.ts` records as `unsigned-local` having no
 * `host-connector` process.
 *
 * At module scope, before render, for the same reason as `configureApiRuntime`.
 */
configureDesktopMachineRemoteAccess()

startDesktopRenderer({ getAuthToken })

/**
 * The UNSIGNED desktop renderer entry.
 *
 * `index.tsx` is the signed one. The difference is not a flag, and this is the
 * lesson the whole split is built on: a single entry with `if (signedBuild)`
 * still ships the identity provider, because the import graph does not care
 * whether the branch runs. `@claxedo/app`'s `src/app/entry/local.tsx` states
 * the same thing for the browser product; this file is its desktop counterpart,
 * and it exists for one reason — so that an unsigned desktop's bundle cannot
 * contain code it can never use.
 *
 * Concretely, what this entry does NOT import, and why each matters:
 *
 *   - `@claxedo/app/auth` — the package's authenticated-identity subpath, and
 *     the only edge by which this package reaches `auth-client.ts` and Clerk.
 *     `index.tsx` imports it for `getAuthToken` / `useAuth`; that one specifier
 *     is the entire difference between the two bundles.
 *   - `@/platform/remote-access/machine-remote-access`'s binder — publishing a
 *     machine to the Host Connector is an account-authorized operation, and
 *     `unsigned-local` has no account and starts no connector process.
 *
 * And what it therefore does not BIND: `configureApiRuntime({ bearerToken })`,
 * `configureAuthSession`, `configureDesktopMachineRemoteAccess`. Each port left
 * unbound reports the truth — no Authorization header, an anonymous session,
 * and a remote-access panel that says the capability is absent — rather than a
 * stub that pretends.
 *
 * `renderer-entry-closure.guard.test.ts` asserts those absences against the
 * real import graph rather than trusting this comment.
 */

// @refresh reload
import { startDesktopRenderer } from "./shell"

startDesktopRenderer()

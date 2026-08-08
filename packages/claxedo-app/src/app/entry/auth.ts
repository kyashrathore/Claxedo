/**
 * The package's authenticated-identity surface, on its own subpath.
 *
 * These used to be re-exported from `entry/index.tsx`. That made Clerk — the
 * largest dependency in this bundle — a static edge of the package's MAIN
 * entry, so anything importing `@claxedo/app` for `getDefaultConfig` pulled the
 * whole identity provider with it. The local product entry does exactly that,
 * and could never sign in.
 *
 * A re-export is a real import edge even when nothing calls the symbol, which
 * is why moving these was the fix and marking them lazy was not.
 *
 * Consumers that genuinely need an account should be moving to the tokenless
 * `AccountPort` (`platform/account/account-port.ts`), where the credential
 * never reaches the renderer at all. This subpath exists so the migration can
 * happen per-consumer instead of blocking the entry split on it.
 */

export { clerk as authClient, waitForClerk, initializeClerk, getAuthToken } from "@/platform/auth/auth-client"
export { useAuthSession } from "@/platform/auth/auth-session"
export type { AuthSession, AuthSessionStatus } from "@/platform/auth/auth-session"

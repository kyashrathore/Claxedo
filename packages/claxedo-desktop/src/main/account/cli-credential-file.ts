import type { ClaxedoCredentials } from "@claxedo/helpers/claxedo-credentials"

import type { BoundDesktopCredential } from "./auth-descriptor"

/**
 * How much of the desktop's session the `claxedo` CLI on this machine may
 * borrow.
 *
 * Off is the default and the only state that writes nothing: the file is the
 * whole account in plaintext on disk, outside the OS keychain the desktop
 * otherwise keeps this credential in, and anything that can read the user's
 * home directory can spend it.
 *
 * `access-token` shares a credential that dies with the desktop's current
 * one — minutes, not days — so the CLI keeps working while the user is
 * working and asks them to sign in again afterwards. `with-refresh` adds the
 * refresh token, which renews itself for as long as the deployment allows;
 * only a user who says so gets it.
 */
export type CliSignInMode = "off" | "access-token" | "with-refresh"

/** Marks a credential file this desktop wrote, so it never clears one `claxedo login` left. */
export const DESKTOP_CLI_IDENTITY = "claxedo-desktop"

export const CLI_SIGN_IN_MODE_KEY = "cliSignInMode"

/** Off unless the settings store holds one of the other two spellings, so an absent or corrupt value writes nothing. */
export function readCliSignInMode(settings: { get: (key: string) => unknown }): CliSignInMode {
  const value = settings.get(CLI_SIGN_IN_MODE_KEY)
  return value === "access-token" || value === "with-refresh" ? value : "off"
}

export type CliCredentialFilePort = {
  /** Called whenever the account's credential changes; writes, or clears what this desktop wrote when turned off. */
  publish: (credential: BoundDesktopCredential) => Promise<void>
  /** Called on sign-out. */
  revoke: () => Promise<void>
}

/**
 * The CLI reads `expiresAt` against `Date.now()`; the desktop's token set
 * counts seconds. Handing the CLI seconds makes every credential look decades
 * expired, and the CLI refuses it.
 */
export function cliCredentials(credential: BoundDesktopCredential, mode: CliSignInMode): ClaxedoCredentials {
  const { binding, tokens } = credential
  return {
    controlPlaneUrl: binding.controlPlaneOrigin,
    accessToken: tokens.accessToken,
    tokenType: "Bearer",
    expiresAt: tokens.expiresAt * 1000,
    identity: DESKTOP_CLI_IDENTITY,
    ...(mode === "with-refresh" && tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
  }
}

/**
 * Mirrors the desktop's account into the file the CLI reads, when the user
 * asked for that.
 *
 * `mode` is read per call rather than captured, so turning the setting off
 * takes effect on the next credential change — a refresh, minutes away — and
 * clears the file rather than leaving the last credential in it.
 */
export function createCliCredentialFile(input: {
  mode: () => CliSignInMode
  read: () => Promise<ClaxedoCredentials | undefined>
  write: (value: ClaxedoCredentials) => Promise<void>
  clear: () => Promise<void>
  onError?: (error: unknown) => void
}): CliCredentialFilePort {
  const clearOurs = async () => {
    const current = await input.read()
    // A file `claxedo login` wrote is the user's own separate sign-in, and
    // this desktop has no standing to end it.
    if (current?.identity !== DESKTOP_CLI_IDENTITY) return
    await input.clear()
  }

  const guarded = async (run: () => Promise<void>) => {
    try {
      await run()
    } catch (error) {
      input.onError?.(error)
    }
  }

  return {
    publish: async (credential) => {
      const mode = input.mode()
      await guarded(() => (mode === "off" ? clearOurs() : input.write(cliCredentials(credential, mode))))
    },
    revoke: () => guarded(clearOurs),
  }
}

import { describe, expect, test } from "bun:test"
import type { ClaxedoCredentials } from "@claxedo/helpers/claxedo-credentials"

import type { BoundDesktopCredential } from "./auth-descriptor"
import {
  CLI_SIGN_IN_MODE_KEY,
  cliCredentials,
  createCliCredentialFile,
  readCliSignInMode,
  type CliSignInMode,
} from "./cli-credential-file"

const CREDENTIAL: BoundDesktopCredential = {
  binding: {
    kind: "desktop",
    tokenKind: "access-token",
    adapter: "better-auth",
    deploymentId: "dep_1",
    configurationVersion: "config_1",
    issuer: "https://core.example/api/auth",
    flow: "authorization-code-pkce",
    tokenEndpointOrigin: "https://core.example",
    controlPlaneOrigin: "https://core.example",
    id: "desktop_1",
    resource: "https://core.example/api/claxedo",
    scopes: ["openid", "offline_access"],
  },
  tokens: { accessToken: "at", refreshToken: "rt", expiresAt: 1_800_000_000 },
}

function bridge(mode: CliSignInMode, existing?: ClaxedoCredentials) {
  const writes: ClaxedoCredentials[] = []
  let cleared = 0
  let current = existing
  const port = createCliCredentialFile({
    mode: () => mode,
    read: async () => current,
    write: async (value) => {
      writes.push(value)
      current = value
    },
    clear: async () => {
      cleared++
      current = undefined
    },
  })
  return { port, writes, cleared: () => cleared }
}

describe("CLI sign-in from the desktop", () => {
  test("sign-out clears a credential even when its preceding write is still pending", async () => {
    let current: ClaxedoCredentials | undefined
    let release = () => {}
    let started = () => {}
    const writing = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const port = createCliCredentialFile({
      mode: () => "with-refresh",
      read: async () => current,
      write: async (value) => { started(); await gate; current = value },
      clear: async () => { current = undefined },
    })
    const publication = port.publish(CREDENTIAL)
    await writing
    const revocation = port.revoke()
    await Promise.resolve()
    release()
    await Promise.all([publication, revocation])
    expect(current).toBeUndefined()
  })

  test("is off unless the settings store says otherwise", () => {
    expect(readCliSignInMode({ get: () => undefined })).toBe("off")
    expect(readCliSignInMode({ get: () => true })).toBe("off")
    expect(readCliSignInMode({ get: () => "yes-please" })).toBe("off")
    expect(readCliSignInMode({ get: (key) => (key === CLI_SIGN_IN_MODE_KEY ? "access-token" : undefined) }))
      .toBe("access-token")
    expect(readCliSignInMode({ get: () => "with-refresh" })).toBe("with-refresh")
  })

  test("writes nothing while it is off", async () => {
    const { port, writes, cleared } = bridge("off")

    await port.publish(CREDENTIAL)

    expect(writes).toEqual([])
    expect(cleared()).toBe(0)
  })

  test("shares the access token without the refresh token by default", async () => {
    const { port, writes } = bridge("access-token")

    await port.publish(CREDENTIAL)

    expect(writes).toEqual([{
      controlPlaneUrl: "https://core.example",
      accessToken: "at",
      tokenType: "Bearer",
      // The CLI compares this against `Date.now()`; the desktop counts seconds.
      expiresAt: 1_800_000_000_000,
      identity: "claxedo-desktop",
    }])
    expect(writes[0] && "refreshToken" in writes[0]).toBe(false)
  })

  test("shares the refresh token only when the user asked for it", async () => {
    const { port, writes } = bridge("with-refresh")

    await port.publish(CREDENTIAL)

    expect(writes[0]).toMatchObject({ refreshToken: "rt" })
  })

  test("clears its own file on sign-out", async () => {
    const { port, cleared } = bridge("access-token", cliCredentials(CREDENTIAL, "access-token"))

    await port.revoke()

    expect(cleared()).toBe(1)
  })

  test("leaves a credential `claxedo login` wrote alone", async () => {
    const own = { controlPlaneUrl: "https://core.example", accessToken: "cli-token", identity: "device-code" }
    const { port, cleared } = bridge("access-token", own)

    await port.revoke()

    expect(cleared()).toBe(0)
  })

  test("turning the setting off clears the file at the next credential change", async () => {
    const { port, cleared, writes } = bridge("off", cliCredentials(CREDENTIAL, "with-refresh"))

    await port.publish(CREDENTIAL)

    expect(writes).toEqual([])
    expect(cleared()).toBe(1)
  })

  test("a file this desktop cannot write does not break the session", async () => {
    const failures: unknown[] = []
    const port = createCliCredentialFile({
      mode: () => "access-token",
      read: async () => undefined,
      write: async () => {
        throw new Error("EACCES")
      },
      clear: async () => undefined,
      onError: (error) => failures.push(error),
    })

    await port.publish(CREDENTIAL)

    expect(failures).toHaveLength(1)
  })
})

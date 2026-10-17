import { asRecord } from "@claxedo/helpers/guards"
import type { AccountsApi, SandboxKeys } from "./account-types"
import type { AccountWrite } from "./account-writes"
import type { CredentialPlane } from "./credential-plane"
import { contractMismatch, toAppError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import type { FetchQuery } from "./types"
import { accountFromWire } from "./wire/accounts"
import { sandboxKeysFromWire } from "./wire/sandbox-keys"

async function sandboxListing(plane: CredentialPlane): Promise<unknown> {
  try {
    return await plane.sandbox()
  } catch (error) {
    if (toAppError(error).status === 501) return undefined
    throw error
  }
}

export function sandboxKeyQueries(server: string, plane: CredentialPlane) {
  const sandbox = (): FetchQuery<SandboxKeys> =>
    fetchQuery(queryKeys.sandboxKeys(server), async () => {
      const body = await sandboxListing(plane)
      if (body === undefined) return { kind: "unsupported" }
      const keys = sandboxKeysFromWire(body)
      if (!keys) throw contractMismatch("sandbox keys")
      return keys
    })
  return { sandbox }
}

export function createSandboxKeyWrites(plane: CredentialPlane, write: AccountWrite): Pick<AccountsApi, "saveSandboxKey" | "chooseSandboxDriver"> {
  return {
    saveSandboxKey: (driver, fields) =>
      write(async () => {
        const body = { provider_id: driver, kind: "sandbox_driver", source: "managed", secret: JSON.stringify(fields) }
        const saved = accountFromWire(asRecord(await plane.save(body))?.credential)
        if (!saved) throw contractMismatch("sandbox key")
        return saved
      }),
    chooseSandboxDriver: (driver) => write(async () => void (await plane.chooseSandboxDriver(driver))),
  }
}

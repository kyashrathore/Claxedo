import { asRecord } from "@claxedo/helpers/guards"
import type { SandboxKeys } from "./account-types"
import type { AccountsApi } from "./api"
import { contractMismatch, responseError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountFromWire } from "./wire/accounts"
import { sandboxKeysFromWire } from "./wire/sandbox-keys"

const CREDENTIALS_PATH = "/api/claxedo/credentials"
const SANDBOX_PATH = `${CREDENTIALS_PATH}/sandbox-drivers`

export function sandboxKeyQueries(transport: Transport) {
  const sandbox = (): FetchQuery<SandboxKeys> =>
    fetchQuery(queryKeys.sandboxKeys(transport.serverUrl), async () => {
      const response = await transport.request(SANDBOX_PATH)
      if (response.status === 501) return { kind: "unsupported" }
      if (!response.ok) throw await responseError(response, `GET ${SANDBOX_PATH}`)
      const keys = sandboxKeysFromWire(await response.json())
      if (!keys) throw contractMismatch("sandbox keys")
      return keys
    })
  return { sandbox }
}

export function createSandboxKeyWrites(transport: Transport, changed: () => Promise<void>): Pick<AccountsApi, "saveSandboxKey" | "chooseSandboxDriver"> {
  return {
    saveSandboxKey: async (driver, fields) => {
      const body = { provider_id: driver, kind: "sandbox_driver", source: "managed", secret: JSON.stringify(fields) }
      const saved = accountFromWire(asRecord(await transport.json(CREDENTIALS_PATH, jsonInit("PUT", body)))?.credential)
      if (!saved) throw contractMismatch("sandbox key")
      await changed()
      return saved
    },
    chooseSandboxDriver: async (driver) => {
      await transport.json(`${SANDBOX_PATH}/default`, jsonInit("PUT", { driver }))
      await changed()
    },
  }
}

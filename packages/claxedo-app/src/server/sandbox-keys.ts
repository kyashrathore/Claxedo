import { asRecord } from "@claxedo/helpers/guards"
import type { HostedAccount } from "./account"
import { accountCheckAnswer, accountRemovalAnswer } from "./account-answers"
import type { AccountsApi, SandboxKeys } from "./account-types"
import type { AccountWrite } from "./account-writes"
import { contractMismatch, toAppError } from "./errors"
import { fetchQuery } from "./fetch-query"
import { queryKeys } from "./query-keys"
import { jsonInit, type Transport } from "./transport"
import type { FetchQuery } from "./types"
import { accountFromWire } from "./wire/accounts"
import { sandboxKeysFromWire } from "./wire/sandbox-keys"

const CREDENTIALS_PATH = "/api/claxedo/credentials"
const SANDBOX_PATH = `${CREDENTIALS_PATH}/sandbox-drivers`

export type SandboxKeyPlane = {
  readonly read: () => Promise<unknown>
  readonly choose: (driver: string | null) => Promise<unknown>
  readonly save: (body: Readonly<Record<string, unknown>>) => Promise<unknown>
  readonly verify: (id: string) => Promise<unknown>
  readonly remove: (id: string) => Promise<unknown>
}

function hostedSandboxKeys(account: HostedAccount): SandboxKeyPlane {
  return {
    read: () => account.run("credentials.sandbox.read"),
    choose: (driver) => account.run("credentials.sandbox.choose", { driver }),
    save: (body) => account.run("credentials.save", body),
    verify: (id) => account.run("credentials.verify", { id }),
    remove: (id) => account.run("credentials.remove", { id }),
  }
}

function serverSandboxKeys(transport: Transport): SandboxKeyPlane {
  const credential = (id: string) => `${CREDENTIALS_PATH}/${encodeURIComponent(id)}`
  return {
    read: () => transport.json(SANDBOX_PATH),
    choose: (driver) => transport.json(`${SANDBOX_PATH}/default`, jsonInit("PUT", { driver })),
    save: (body) => transport.json(CREDENTIALS_PATH, jsonInit("PUT", body)),
    verify: (id) => transport.json(`${credential(id)}/verify`, jsonInit("POST", {})),
    remove: (id) => transport.json(credential(id), { method: "DELETE" }),
  }
}

export function sandboxKeyPlane(transport: Transport, account: HostedAccount | undefined): SandboxKeyPlane {
  return account ? hostedSandboxKeys(account) : serverSandboxKeys(transport)
}

async function sandboxListing(plane: SandboxKeyPlane): Promise<unknown> {
  try {
    return await plane.read()
  } catch (error) {
    if (toAppError(error).status === 501) return undefined
    throw error
  }
}

export function sandboxKeyQueries(server: string, plane: SandboxKeyPlane) {
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

export function createSandboxKeyWrites(plane: SandboxKeyPlane, write: AccountWrite): Pick<AccountsApi, "saveSandboxKey" | "chooseSandboxDriver" | "checkSandboxKey" | "removeSandboxKey"> {
  return {
    saveSandboxKey: (driver, fields) =>
      write(async () => {
        const body = { provider_id: driver, kind: "sandbox_driver", source: "managed", secret: JSON.stringify(fields) }
        const saved = accountFromWire(asRecord(await plane.save(body))?.credential)
        if (!saved) throw contractMismatch("sandbox key")
        return saved
      }),
    chooseSandboxDriver: (driver) => write(async () => void (await plane.choose(driver))),
    checkSandboxKey: (id) => write(async () => accountCheckAnswer(await plane.verify(id))),
    removeSandboxKey: (id) => write(async () => accountRemovalAnswer(await plane.remove(id))),
  }
}

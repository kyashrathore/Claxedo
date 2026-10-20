import { expect, test } from "vitest"
import type { ControlPlaneCredentials } from "../../authority/services"
import { orgRoutedCredentials, type CredentialChange } from "./org-routed"

test("an account save reads the organization's deliveries around it, and a sandbox provider key's save does not", async () => {
  const changes: string[] = []
  const change: CredentialChange = async (orgId) => {
    changes.push(`before ${orgId}`)
    return async () => void changes.push(`after ${orgId}`)
  }
  const store = { putCredential: async (input: { provider_id: string }) => ({ id: input.provider_id }) } as unknown as ControlPlaneCredentials
  const routed = orgRoutedCredentials(() => store, change)
  await routed.putCredential({ owner: null, provider_id: "boat", kind: "sandbox_driver", source: "managed", secret: "{}" }, "org_1")
  expect(changes).toEqual([])
  await routed.putCredential({ owner: "usr_1", provider_id: "anthropic", kind: "api_key", source: "managed", secret: "sk-ant" }, "org_1")
  expect(changes).toEqual(["before org_1", "after org_1"])
})

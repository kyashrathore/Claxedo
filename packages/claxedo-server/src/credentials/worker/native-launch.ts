import type { ResolvedCredentials } from "@claxedo/harness/contract"
import type { SignedControlPlaneAuth } from "@claxedo/server-core/platform/auth/auth"
import { harnessModelAccount, harnessModelList, storedAccountToken } from "@claxedo/server-core/credentials/harness-model-list"
import type { ControlPlaneCredentials } from "../../authority/services"

export type MachineHarnessDraft = {
  readonly workspaceId: string
  readonly harness: "claude" | "codex" | "cursor"
  readonly model?: string
  readonly credentials: ResolvedCredentials
}

/**
 * A machine harness's models while its workspace's runtime is not up, so a
 * draft picks one without waking the sandbox (`harnessModelList`). A ready
 * runtime answers with its own instead, and so does a draft whose accounts
 * give the list nothing to read with.
 */
export function hostedMachineHarnessLaunch(input: {
  resolveOrgId(auth: SignedControlPlaneAuth): Promise<string>
  credentials: ((orgId: string) => ControlPlaneCredentials) | undefined
  runtimeReady(workspaceId: string): Promise<boolean>
  fetch?: typeof fetch
}) {
  const cursorToken = async (auth: SignedControlPlaneAuth, credentialId: string) => {
    const store = input.credentials?.(await input.resolveOrgId(auth))
    return store && await storedAccountToken(store, credentialId)
  }
  return {
    machineHarnessLaunch: async (auth: SignedControlPlaneAuth, draft: MachineHarnessDraft) => {
      if (await input.runtimeReady(draft.workspaceId)) return undefined
      const account = harnessModelAccount(draft.credentials, draft.harness)
      if (account?.kind !== "stored") return undefined
      return harnessModelList({
        harness: draft.harness,
        account,
        ...(draft.model ? { model: draft.model } : {}),
        cursorToken: (credentialId) => cursorToken(auth, credentialId),
        ...(input.fetch ? { fetch: input.fetch } : {}),
      })
    },
  }
}

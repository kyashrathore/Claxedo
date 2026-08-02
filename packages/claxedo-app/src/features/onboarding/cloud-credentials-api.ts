import { claxedoCredentialRequest } from "@/platform/api/credential-request"
import type { AIConnectRequest } from "./ai-connect-api"

/**
 * Materializing a credential to the cloud is a scope change on something already
 * saved — never a re-collection. Collect-and-save happens once, on the AI step;
 * this only widens who may spend what is already there.
 */
export type CloudShareOutcome =
  | { credentialId: string; ok: true }
  | { credentialId: string; ok: false; reason: string }

export async function shareCredentialWithCloud(input: {
  serverUrl?: string
  credentialId: string
  request?: AIConnectRequest
}): Promise<CloudShareOutcome> {
  const request = input.request ?? claxedoCredentialRequest
  try {
    await request({
      serverUrl: input.serverUrl,
      credentialId: input.credentialId,
      action: "scope",
    }, {
      method: "PATCH",
      body: JSON.stringify({ scope: "shared" }),
    })
    return { credentialId: input.credentialId, ok: true }
  } catch (error) {
    return { credentialId: input.credentialId, ok: false, reason: shareFailureCopy(error) }
  }
}

/**
 * Each credential settles on its own. One failure must not discard the others —
 * that first-failure-wins reduction is what made the old AI step report a
 * partially successful save as a total failure.
 */
export async function shareCredentialsWithCloud(input: {
  serverUrl?: string
  credentialIds: readonly string[]
  request?: AIConnectRequest
}): Promise<CloudShareOutcome[]> {
  return Promise.all(input.credentialIds.map((credentialId) => shareCredentialWithCloud({
    serverUrl: input.serverUrl,
    credentialId,
    request: input.request,
  })))
}

/**
 * Never surface a raw server message — map it to a sentence that says what to do
 * next. `claxedoCredentialRequest` throws with the server's own error message,
 * which is the only signal we get about which failure this was.
 */
export function shareFailureCopy(error: unknown) {
  const message = (error instanceof Error ? error.message : String(error ?? "")).toLowerCase()
  if (message.includes("unavailable") || message.includes("501")) {
    return "This server can't share credentials with cloud sandboxes yet."
  }
  if (message.includes("not found") || message.includes("404")) {
    return "That credential is no longer saved. Reconnect it and try again."
  }
  return "Couldn't share this credential. Try again."
}

import { createHmac } from "node:crypto"

export function deriveChildSessionId(secret: string, input: { callerIdentity: string; clientRequestId: string }): string {
  const digest = createHmac("sha256", secret).update(`${input.callerIdentity}\0${input.clientRequestId}`).digest("hex")
  return `ses_${digest.slice(0, 32)}`
}

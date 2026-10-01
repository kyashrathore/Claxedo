/** A keyed child-session id derived with Web Crypto HMAC, the way a host without `node:crypto` supplies `deriveSessionId`. */
export async function hmacChildSessionId(secret: string, input: { callerIdentity: string; clientRequestId: string }) {
  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(`${input.callerIdentity}\0${input.clientRequestId}`))
  return `ses_${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 32)}`
}

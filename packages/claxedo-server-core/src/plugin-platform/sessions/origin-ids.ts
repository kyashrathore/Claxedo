import { sha256Hex } from "@claxedo/helpers/crypto"

/**
 * What a session was started for. The key alone names the origin's
 * reservation and cloud root, so every owner renders keys no other owner can
 * produce; the namespace prefixes the session and message ids.
 */
export type SessionOrigin = Readonly<{ namespace: string; key: string }>

/**
 * The ids an origin decides, so two clients racing one origin converge on one
 * session and one first message instead of two of each, and a handoff that
 * runs long after the create addresses the same message.
 */
export async function originIds(origin: SessionOrigin): Promise<{ sessionId: string; messageId: string }> {
  const hash = (await sha256Hex(origin.key)).slice(0, 32)
  return { sessionId: `ses_${origin.namespace}_${hash}`, messageId: `msg_${origin.namespace}_${hash}` }
}

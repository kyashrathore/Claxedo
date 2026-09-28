import { createHash } from "node:crypto"

export function grantIdentity(identity: unknown): string {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex")
}

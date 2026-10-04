import { existsSync } from "node:fs"
import { join } from "node:path"

/** Nonsecret presence marker read by the base Electron main composition. */
export const ACCOUNT_CREDENTIAL_RECORD = "account-credential.json"

export function hasAccountCredentialRecord(userDataDir: string) {
  return existsSync(join(userDataDir, ACCOUNT_CREDENTIAL_RECORD))
}

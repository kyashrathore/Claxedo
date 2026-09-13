import fs from "fs"
import path from "path"
import { deleteCredential, listCredentials } from "@claxedo/server-core/credentials/registry"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

const log = Log.create({ service: "credentials-drop-copied-logins" })

const MARKER_FILE = path.join(dataDir(), "credentials", ".harness-logins-dropped")

/**
 * A row the machine scan took off this computer and that no provider ever
 * named.
 *
 * The pair is what identifies it: `desktop_discovery` says the scan wrote it,
 * and the absent `account_id` says the provider gave it no identity of its own,
 * which was true of exactly one kind of row — the Claude Code login read out of
 * the Keychain or `~/.claude/.credentials.json`. A discovered Codex account
 * carries its ChatGPT id and is a real second account the user chose to import.
 */
function isCopiedHarnessLogin(credential: CredentialMetadata) {
  return credential.consent?.surface === "desktop_discovery" && !credential.account_id
}

/**
 * Forget the harness logins an older Claxedo copied off this machine.
 *
 * They are the thing the model now forbids: a token belonging to a CLI that
 * rotates it, held in our store where it goes stale and is spent as though the
 * user had chosen it. Deleting rather than leaving them is safe because nothing
 * is lost — the login is still in the harness, and asking it is how every
 * surface now finds out. The delete takes the secret with it and hands the
 * active mark to whatever account the user did choose.
 *
 * Once per install, marked beside the other credential migration so an operator
 * who re-imported deliberately is not re-reaped on the next boot.
 */
export async function dropCopiedHarnessLogins(): Promise<{ dropped: number }> {
  if (fs.existsSync(MARKER_FILE)) return { dropped: 0 }
  const copied = listCredentials().filter(isCopiedHarnessLogin)
  let dropped = 0
  for (const credential of copied) {
    try {
      // Awaited one at a time: each delete takes the backend secret with it,
      // and the count is what the operator is told.
      if (await deleteCredential(credential.id)) dropped += 1
    } catch (error) {
      log.warn("Failed to forget a copied harness login", {
        credential_id: credential.id,
        provider_id: credential.provider_id,
        error: String(error),
      })
    }
  }
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true, mode: 0o700 })
    fs.writeFileSync(MARKER_FILE, new Date().toISOString(), { mode: 0o600 })
  } catch (error) {
    log.warn("Failed to record that copied harness logins were forgotten", { error: String(error) })
  }
  if (dropped > 0) log.info("Forgot harness logins an older Claxedo had copied", { dropped })
  return { dropped }
}

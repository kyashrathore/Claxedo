import fs from "fs"
import path from "path"
import { harnessBindingIds, harnessForProviderId } from "@claxedo/agent-runtime-contract"
import { deleteCredential, listCredentials } from "@claxedo/server-core/credentials/registry"
import { dataDir } from "@claxedo/server-core/platform/runtime/lib/paths"
import { Log } from "@claxedo/server-core/platform/runtime/lib/log"
import type { CredentialMetadata } from "@claxedo/server-core/credentials/types"

const log = Log.create({ service: "credentials-drop-copied-logins" })

const MARKER_FILE = path.join(dataDir(), "credentials", ".harness-logins-dropped")

/**
 * A row the machine scan took off this computer that is a harness's own login.
 *
 * Three facts together: the scan wrote it (`desktop_discovery`), it is a
 * subscription token rather than a key the user pasted (`oauth_token`), and it
 * is stored against a binding a harness resolves its own auth through. An API
 * key the same scan found in the environment fails the second, and a vendor
 * token for an engine to run on fails the third, so neither is reaped. The
 * vendor id sits in the harness table too, under the harness whose models it
 * names, which is why the test is the binding list and not table membership.
 */
function isCopiedHarnessLogin(credential: CredentialMetadata) {
  const harness = harnessForProviderId(credential.provider_id)
  return credential.consent?.surface === "desktop_discovery"
    && credential.kind === "oauth_token"
    && harness !== undefined
    && harnessBindingIds(harness).includes(credential.provider_id)
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
  // Marked before the first delete, never after: a marker write that fails once
  // the rows are gone leaves the pass to run again on the next boot, and by
  // then the rows it reaps are the ones the user re-imported on purpose. An
  // unwritable marker instead costs this boot's deletes, which the next pass
  // does.
  if (!markDropped()) return { dropped: 0 }
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
  if (dropped > 0) log.info("Forgot harness logins an older Claxedo had copied", { dropped })
  return { dropped }
}

function markDropped() {
  try {
    fs.mkdirSync(path.dirname(MARKER_FILE), { recursive: true, mode: 0o700 })
    fs.writeFileSync(MARKER_FILE, new Date().toISOString(), { mode: 0o600 })
    return true
  } catch (error) {
    log.warn("Failed to record that copied harness logins were forgotten", { error: String(error) })
    return false
  }
}

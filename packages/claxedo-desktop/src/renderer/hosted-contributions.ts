/**
 * The signed desktop's optional renderer activation.
 *
 * This module is reached only through `local.tsx`'s dynamic import. Vite gives
 * it a content-hashed filename, and an unsigned self-build removes that import
 * before Rollup links the graph. It deliberately imports no identity provider:
 * Electron main already owns the credential and exposes only named operations
 * through the AccountPort bridge.
 */

import { hostedContributionLoader } from "@/app/composition/hosted-contribution-loader"
import { configureDesktopMachineRemoteAccess } from "./remote-access/electron-machine-remote-access-binding"

const loadHostedContent = hostedContributionLoader()

export async function loadDesktopHostedContributions() {
  // Binding belongs to activation, not base startup. The binder itself refuses
  // a missing/partial preload bridge; there is no HTTP fallback to the local
  // server, which does not own these routes.
  configureDesktopMachineRemoteAccess()
  return loadHostedContent()
}

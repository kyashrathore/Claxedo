/**
 * The signed desktop's optional renderer activation.
 *
 * This module is reached only through `local.tsx`'s dynamic import. Vite gives
 * it a content-hashed filename, and an unsigned self-build removes that import
 * before Rollup links the graph. It deliberately imports no identity provider:
 * Electron main already owns the credential and exposes only named operations
 * through the AccountPort bridge.
 */

import { cloudWorkspaceStartup } from "@/platform/runtime/cloud/workspace-runtime-store"
import { configureWorkspaceStartup } from "@/platform/runtime/workspace-startup"
import { configureDesktopMachineRemoteAccess } from "./remote-access/electron-machine-remote-access-binding"

export async function loadDesktopHostedContributions() {
  // These bindings belong to signed activation, not base startup. Remote
  // access crosses Electron's AccountPort and workspace startup uses the same
  // cloud runtime implementation as the hosted browser. Neither has a local
  // fallback: the unsigned desktop owns no hosted route or sandbox.
  configureDesktopMachineRemoteAccess()
  // Cloud workspace creation runs from shared composer code on desktop too
  // (`submit-directory.ts`, `session-actions.tsx` call `workspaceStartup()`),
  // and this is the only desktop binding — without it a desktop cloud create
  // throws "this build bound no hosted workspace startup".
  configureWorkspaceStartup(cloudWorkspaceStartup)
  // Optional service renderers have independent catalog-driven loaders. Core
  // account activation owns no Documents surface.
  return { contentSurfaces: [] }
}

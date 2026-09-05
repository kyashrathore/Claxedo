import type { WorkspaceStartupPort } from "./workspace-startup-port"

/**
 * Who supplies the workspace-startup port for this build.
 *
 * `platform/account/account-provider.tsx` does the same job through a Solid
 * context, because every account reader is a component. This seam cannot be a
 * context: its callers are plain modules (`composer/ui/submit-directory.ts`
 * runs inside a submit, not inside a render), so the binding is module-scoped
 * and composition installs it once at boot.
 *
 * The hosted browser entry (`app/entry/main.tsx`) and the desktop's optional
 * signed activation bind `cloudWorkspaceStartup`. The local browser and the
 * desktop's unsigned base bind nothing, deliberately: those products have no
 * sandbox to wake and no Relay to reach, so the hosted implementation stays
 * out of their base bundles.
 */
let boundPort: WorkspaceStartupPort | undefined

export function configureWorkspaceStartup(port: WorkspaceStartupPort) {
  boundPort = port
}

/**
 * Throws when this build bound no implementation.
 *
 * Deliberately not a tolerant accessor returning `undefined`. A ports seam that
 * degrades quietly is how the hosted doorbell shipped inert with a green
 * suite (`architecture/app-ports-wiring.guard.test.ts` records that failure),
 * and the equivalent here would be a cloud submit that silently reports success
 * against a runtime nobody woke. Reaching this in a local build means a hosted
 * surface rendered where it cannot work — a wiring bug, and it should say so.
 */
export function workspaceStartup(): WorkspaceStartupPort {
  if (!boundPort) {
    throw new Error(
      "workspaceStartup() requires configureWorkspaceStartup() -- this build bound no hosted workspace startup",
    )
  }
  return boundPort
}

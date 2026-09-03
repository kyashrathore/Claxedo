import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { lazy, onMount, Suspense, type ParentProps } from "solid-js"
import { Toast } from "@opencode-ai/ui/toast"
import { ClaxedoSplash } from "@/ui/controls/claxedo-logo"
import { markShellRevealed, shellRevealedOnce } from "@/app/shell-revealed"
import { ClaxedoStateProvider } from "./workbench/state"

trace("runtime.appShellBootstrapEvaluated")

const ClaxedoAppShellInner = lazy(() => {
  return import("./app-shell").then((module) => {
    trace("runtime.appShellInnerEvaluated")
    return { default: module.ClaxedoAppShellInner }
  })
})

/**
 * Boot-only. This boundary wraps the WHOLE shell, so replaying the full-page
 * splash for later suspensions replaced the entire app with a boot logo the
 * moment anything under the shell suspended — opening the account menu did
 * exactly that (its org/team resources read under this boundary), and when
 * the read hung the splash never left. After the shell has revealed once, a
 * later suspension keeps the window quiet instead of announcing a fresh boot.
 */
function ShellSuspenseFallback() {
  if (shellRevealedOnce()) return <div class="size-full" />
  return (
    <div class="fixed inset-0 z-[9999] h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
      <ClaxedoSplash class="w-16 h-20 opacity-50 animate-pulse" />
    </div>
  )
}

/** The user is looking at the real shell from here on — see shell-revealed.ts. */
function ShellRevealedMarker() {
  onMount(markShellRevealed)
  return null
}

export function ClaxedoAppShell(props: ParentProps) {
  return (
    <ClaxedoStateProvider>
      <Toast.Region />
      <Suspense fallback={<ShellSuspenseFallback />}>
        <ClaxedoAppShellInner>
          <ShellRevealedMarker />
          {props.children}
        </ClaxedoAppShellInner>
      </Suspense>
    </ClaxedoStateProvider>
  )
}

function trace(name: string) {
  markRendererPhase(name)
}

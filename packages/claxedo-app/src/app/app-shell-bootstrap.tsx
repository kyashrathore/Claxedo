import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { lazy, Suspense, type ParentProps } from "solid-js"
import { Toast } from "@opencode-ai/ui/toast"
import { ClaxedoSplash } from "@/ui/controls/claxedo-logo"
import { ClaxedoStateProvider } from "./workbench/state"

trace("runtime.appShellBootstrapEvaluated")

const ClaxedoAppShellInner = lazy(() => {
  return import("./app-shell").then((module) => {
    trace("runtime.appShellInnerEvaluated")
    return { default: module.ClaxedoAppShellInner }
  })
})

export function ClaxedoAppShell(props: ParentProps) {
  return (
    <ClaxedoStateProvider>
      <Toast.Region />
      <Suspense
        fallback={
          <div class="fixed inset-0 z-[9999] h-dvh w-screen flex flex-col items-center justify-center bg-background-base">
            <ClaxedoSplash class="w-16 h-20 opacity-50 animate-pulse" />
          </div>
        }
      >
        <ClaxedoAppShellInner>{props.children}</ClaxedoAppShellInner>
      </Suspense>
    </ClaxedoStateProvider>
  )
}

function trace(name: string) {
  markRendererPhase(name)
}

import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { lazy, Suspense, type ParentProps } from "solid-js"
import { Toast } from "@opencode-ai/ui/toast"
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
      <Suspense fallback={null}>
        <ClaxedoAppShellInner>{props.children}</ClaxedoAppShellInner>
      </Suspense>
    </ClaxedoStateProvider>
  )
}

function trace(name: string) {
  markRendererPhase(name)
}

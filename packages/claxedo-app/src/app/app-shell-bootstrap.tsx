import { markRendererPhase } from "@/platform/performance/renderer-trace"
import { lazy, Loading, type ParentProps } from "solid-js"
import { Toast } from "@opencode-ai/ui/toast"
import { ClaxedoStateProvider } from "./workbench/state"
import { productContributions } from "./composition/product-contributions"

trace("runtime.appShellBootstrapEvaluated")

const ClaxedoAppShellInner = lazy(() => {
  return import("./app-shell").then((module) => {
    trace("runtime.appShellInnerEvaluated")
    return { default: module.ClaxedoAppShellInner }
  })
})

export function ClaxedoAppShell(props: ParentProps) {
  return (
    <ClaxedoStateProvider availableContentTypes={productContributions().availableContentTypes()}>
      <Toast.Region />
      <Loading fallback={null}>
        <ClaxedoAppShellInner>{props.children}</ClaxedoAppShellInner>
      </Loading>
    </ClaxedoStateProvider>
  )
}

function trace(name: string) {
  markRendererPhase(name)
}

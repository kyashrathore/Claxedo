import type { ParentProps } from "solid-js"
import { Toast } from "@opencode-ai/ui/toast"
import { ClaxedoStateProvider } from "./workbench/state"
import { ClaxedoAppShellInner } from "./app-shell"
import { recordRendererPhase } from "@/platform/performance/renderer-trace"

recordRendererPhase("runtime.appShellBootstrapEvaluated")

export function ClaxedoAppShell(props: ParentProps) {
  return (
    <ClaxedoStateProvider>
      <Toast.Region />
      <ClaxedoAppShellInner>{props.children}</ClaxedoAppShellInner>
    </ClaxedoStateProvider>
  )
}

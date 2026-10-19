import { Show, untrack, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { SurfaceAgentConfiguration } from "@claxedo/plugin-api/surface"
import { useTranslator } from "@/i18n"
import { boundAgentConfiguration, boundAgentPlacement } from "../agent-configuration"
import { resolvePath } from "../data-path"
import { surfaceDictionary } from "../i18n"
import type { SurfaceNodeProps } from "../model"
import { useSurfaceReferences } from "./surface-references"
import { useSurfaceReader, useSurfaceRuntime } from "./surface-runtime"

export function AgentConfigurationPickerView(props: SurfaceNodeProps<"AgentConfigurationPicker">): JSX.Element {
  const runtime = useSurfaceRuntime()
  const read = useSurfaceReader()
  const references = useSurfaceReferences()
  const t = useTranslator(surfaceDictionary)
  const path = () => resolvePath(props.def.value.path, props.scope)
  const change = (value: SurfaceAgentConfiguration) => {
    runtime.state.data.write(untrack(path), value)
    runtime.fire(untrack(() => props.def.change), props.def.id, untrack(() => props.scope), { value })
  }
  const drawn = () => (runtime.source.kind === "agent" ? undefined : references)
  return (
    <Show when={drawn()} fallback={<p class="text-12-regular text-text-weak">{t("surface.reference.unavailable")}</p>}>
      {(drawn) => (
        <Dynamic
          component={drawn().AgentConfigurationPicker}
          placement={boundAgentPlacement(read.value(props.def.placement, props.scope))}
          value={boundAgentConfiguration(runtime.state.data.read(path()))}
          disabled={read.value(props.def.disabled, props.scope) === true}
          onChange={change}
        />
      )}
    </Show>
  )
}

import { useTranslator } from "@/i18n"
import { Icon, type IconProps } from "@/ui"
import { surfaceDictionary } from "../i18n"
import type { SurfaceSource } from "../model"

const SOURCE_ICONS: Readonly<Record<SurfaceSource["kind"], IconProps["name"]>> = {
  agent: "subagent",
  plugin: "marketplace",
}

export function SurfaceSourceMark(props: { readonly source: SurfaceSource }) {
  const t = useTranslator(surfaceDictionary)
  return (
    <div data-slot="surface-source">
      <Icon name={SOURCE_ICONS[props.source.kind]} size="small" />
      <span>{t(props.source.kind === "agent" ? "surface.source.agent" : "surface.source.plugin", { name: props.source.label })}</span>
    </div>
  )
}

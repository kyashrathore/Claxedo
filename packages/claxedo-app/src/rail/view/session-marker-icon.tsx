import type { JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { ClaxedoIcon as Icon, Tooltip } from "@/ui"
import { railDictionary } from "../i18n"
import { markerLabel, type SessionMarker } from "../session-marker"

const MARKER_ICON = { cloud: "cloud", machine: "server", worktree: "worktree" } as const

export function SessionMarkerIcon(props: { readonly marker: SessionMarker; readonly projectLabel: string }): JSX.Element {
  const t = useTranslator(railDictionary)
  const label = () => markerLabel(t, props.marker, props.projectLabel)
  return (
    <Tooltip value={label()} placement="right" contentClass="max-w-[280px] break-all" class="pointer-events-auto relative z-10 -my-1 size-6 shrink-0 items-center justify-center">
      <span role="img" aria-label={label()} class="flex items-center text-icon-weak-base">
        <Icon name={MARKER_ICON[props.marker.kind]} size="small" />
      </span>
    </Tooltip>
  )
}

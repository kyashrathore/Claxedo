import { Show, type JSX } from "solid-js"
import { useRootListingPrefetch } from "@/files"
import { useTranslator } from "@/i18n"
import { SidePanelToggle } from "@/ui"
import { panelDictionary } from "../i18n"
import { usePanel } from "../store"
import { workspaceTabIcon } from "../tab-presentation"

function PanelToggleButton(): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  const prefetchRootListing = useRootListingPrefetch()
  const label = () => (panel.open() ? t("panel.close") : t("panel.open"))
  return (
    <SidePanelToggle
      testId="workspace-panel-toggle"
      label={label()}
      open={panel.open()}
      onPointerDown={(event) => {
        const placementId = panel.placementId()
        if (event.button !== 0 || panel.open() || panel.phone() || !placementId) return
        if (panel.openingNavigator() === "files") prefetchRootListing(placementId)
      }}
      onToggle={panel.toggle}
    />
  )
}

function SessionDetailsToggle(): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  return (
    <SidePanelToggle
      testId="session-details-toggle"
      icon={workspaceTabIcon("context")}
      label={t("panel.details.show")}
      open={false}
      onToggle={() => panel.show({ kind: "context" })}
    />
  )
}

export function PanelToggle(): JSX.Element {
  const panel = usePanel()
  return (
    <Show when={!panel.open()}>
      <div data-testid="workspace-panel-floating-chrome" class="flex items-center gap-0.5">
        <Show when={panel.sessionId() !== ""}>
          <SessionDetailsToggle />
        </Show>
        <PanelToggleButton />
      </div>
    </Show>
  )
}

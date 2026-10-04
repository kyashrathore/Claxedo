import { type JSX, type ParentProps } from "solid-js"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { SidePanel, SidePanelArea } from "@/ui"
import { panelDictionary } from "../i18n"
import { usePanel } from "../store"
import { PanelBody } from "./panel-body"
import { PanelHeader } from "./panel-header"
import { createWorkspaceResize } from "./resize-handle"
import { maxPanelWidth, PANEL_MIN_WIDTH } from "../width"

function WorkspacePanel(): JSX.Element {
  const t = useTranslator(panelDictionary)
  const panel = usePanel()
  const server = useServer()
  const workspacePath = () => {
    const placementId = panel.placementId()
    return placementId ? (server.placements.byId(placementId)?.path ?? "") : ""
  }
  const resize = createWorkspaceResize(() => undefined)
  return (
    <SidePanel
      open={panel.open()}
      width={panel.width()}
      label={t("panel.label")}
      onAvailable={panel.setAvailable}
      data-testid="workspace-panel-shell"
      data-state-open={panel.open() ? "true" : "false"}
      data-state-mode="review"
      data-state-navigator={panel.navigator() ?? ""}
      data-state-workspace-dir={workspacePath()}
      header={<PanelHeader />}
      resize={
        panel.open() && !panel.phone() && !panel.fullWidth()
          ? {
              label: t("panel.resize"),
              min: PANEL_MIN_WIDTH,
              max: maxPanelWidth(panel.available()),
              onResize: (width) => resize.resize(() => panel.chooseWidth(width)),
              onDragging: resize.dragging,
            }
          : undefined
      }
    >
      {(exposed) => (
        <div data-testid="workspace-panel-body" class="absolute inset-0 overflow-auto">
          <PanelBody tabsShown={exposed()} />
        </div>
      )}
    </SidePanel>
  )
}

export function WorkspaceArea(props: ParentProps): JSX.Element {
  const panel = usePanel()
  return (
    <SidePanelArea
      inset={panel.inset()}
      contentAttributes={{
        "data-testid": "workbench-column",
        "data-floating-host": panel.maximized() ? "" : undefined,
      }}
      panel={<WorkspacePanel />}
    >
      {props.children}
    </SidePanelArea>
  )
}

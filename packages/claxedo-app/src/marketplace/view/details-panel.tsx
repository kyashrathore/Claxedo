import { createEffect, on, Show, type JSX, type ParentProps } from "solid-js"
import { useTranslator } from "@/i18n"
import type { PluginCandidate, PluginHarness, PluginToolGroup } from "@/server"
import { ClaxedoIcon, SidePanel, SidePanelSlot, SidePanelHeader } from "@/ui"
import type { createSelection } from "../directory-state"
import { marketplaceDictionary } from "../i18n"
import { pluginLabel } from "../model"
import { createMarketplacePanelSize, maxDetailsWidth, PANE_MIN_WIDTH } from "../pane-width"
import { PluginDetails } from "./plugin-details"

type MarketplaceDetailsProps = ParentProps<{
  readonly selection: ReturnType<typeof createSelection>
  readonly harnesses: readonly PluginHarness[]
  readonly pending: string | undefined
  readonly onAdd: (plugin: PluginCandidate) => void
  readonly onActivate: (plugin: PluginCandidate, choice: boolean | null) => void
  readonly onUpdate: (plugin: PluginCandidate) => void
  readonly onToolGroup: (plugin: PluginCandidate, group: PluginToolGroup, enabled: boolean) => void
}>

export function MarketplaceDetailsPanel(props: MarketplaceDetailsProps): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const size = createMarketplacePanelSize()
  const open = () => !!props.selection.selected()
  createEffect(
    on(open, (shown) => {
      if (!shown) size.setFullWidth(false)
    }),
  )
  const name = () => {
    const plugin = props.selection.selected()
    return plugin ? pluginLabel(plugin) : ""
  }
  const close = () => props.selection.closePlugin()
  return (
    <>
      <SidePanelSlot
        inset={open() && !size.phone() && !size.fullWidth() ? size.width() : 0}
        panel={
          <SidePanel
            open={open()}
            width={size.width()}
            label={t("marketplace.details", { name: name() })}
            onAvailable={size.setAvailable}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault()
                close()
              }
            }}
            header={
              <SidePanelHeader
                tab={{
                  label: t("marketplace.detailsTab"),
                  icon: <ClaxedoIcon name="document-text" size="small" />,
                  closeLabel: t("marketplace.closeDetails"),
                  onClose: close,
                }}
                controls={{
                  phone: size.phone(),
                  fullWidth: size.fullWidth(),
                  maximizeLabel: t(size.fullWidth() ? "marketplace.restoreDetails" : "marketplace.maximizeDetails"),
                  closeLabel: t("marketplace.closeDetails"),
                  onMaximize: size.toggleFullWidth,
                  onClose: close,
                }}
              />
            }
            resize={
              open() && !size.phone() && !size.fullWidth()
                ? {
                    label: t("marketplace.resizeDetails"),
                    min: PANE_MIN_WIDTH,
                    max: maxDetailsWidth(size.available()),
                    onResize: size.chooseWidth,
                  }
                : undefined
            }
          >
            {(exposed) => (
              <Show when={exposed()}>
                <Show when={props.selection.selected()}>
                  {(plugin) => (
                    <PluginDetails
                      plugin={plugin()}
                      harnesses={props.harnesses}
                      pending={props.pending === plugin().pluginInstanceId}
                      onAdd={() => props.onAdd(plugin())}
                      onActivate={(choice) => props.onActivate(plugin(), choice)}
                      onUpdate={() => props.onUpdate(plugin())}
                      onToolGroup={(group, enabled) => props.onToolGroup(plugin(), group, enabled)}
                    />
                  )}
                </Show>
              </Show>
            )}
          </SidePanel>
        }
      />
      {props.children}
    </>
  )
}

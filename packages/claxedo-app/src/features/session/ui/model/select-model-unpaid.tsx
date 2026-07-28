// Claxedo routes unpaid-model provider prompts through Claxedo-owned provider dialogs.
import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import { List, type ListRef } from "@opencode-ai/ui/list"
import { ProviderIcon } from "@opencode-ai/ui/provider-icon"
import { Tag } from "@opencode-ai/ui/tag"
import { type Component, createMemo, Match, Show, Switch } from "solid-js"
import { useLocal } from "@/features/session/providers/session-selection"
import { useProviders } from "@/features/session/app-ports"
import { popularProviders } from "@/platform/query/provider-list"
import { useLanguage } from "@/platform/i18n/provider"
import { loadConnectProviderDialog, loadSelectProviderDialog } from "@/features/session/app-ports"
import type { PickerItem, PickerState } from "@/features/session/ui/model/select-model"
import { principalHasSignedAccess, usePrincipal } from "@/platform/auth/identity-provider"
import { capture as phCapture, identityProps } from "@/platform/telemetry/analytics"

export function freeOpenCodeModels(models: PickerItem[]) {
  return models.filter((item) => item.provider.id === "opencode" && item.cost?.input === 0 && item.cost.output === 0)
}

export const DialogSelectModelUnpaid: Component<{ model?: PickerState }> = (props) => {
  const model = props.model ?? useLocal().model
  const dialog = useDialog()
  const providers = useProviders()
  const language = useLanguage()
  const principal = usePrincipal()
  const signedIn = () => principalHasSignedAccess(principal())
  const freeModels = createMemo(() => freeOpenCodeModels(model.list()))
  const catalogUnavailable = () => !providers.loading() && !providers.error() && providers.all().size === 0

  const connect = (provider: string) => {
    void loadConnectProviderDialog().then((x) => {
      dialog.show(() => <x.DialogConnectProvider provider={provider} />)
    })
  }

  const all = () => {
    void loadSelectProviderDialog().then((x) => {
      dialog.show(() => <x.DialogSelectProvider />)
    })
  }

  let listRef: ListRef | undefined
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") return
    listRef?.onKeyDown(e)
  }

  return (
    <Dialog
      title={language.t("dialog.model.select.title")}
      class="overflow-y-auto [&_[data-slot=dialog-body]]:overflow-visible [&_[data-slot=dialog-body]]:flex-none"
    >
      <Switch>
        <Match when={!signedIn()}>
          <div class="px-5 py-8 text-center text-14-regular text-text-weak">
            Sign in from the sidebar to load models and providers for this workspace.
          </div>
        </Match>
        <Match when={providers.loading()}>
          <div class="px-5 py-8 text-center text-14-regular text-text-weak">Loading models and providers…</div>
        </Match>
        <Match when={providers.error() || catalogUnavailable()}>
          <div class="flex flex-col items-center gap-3 px-5 py-8 text-center text-14-regular text-text-weak">
            <span>{providers.error() ?? "The provider catalog is unavailable."}</span>
            <Button variant="secondary" onClick={() => void providers.refresh()}>Retry</Button>
          </div>
        </Match>
        <Match when={true}>
          <div class="flex flex-col gap-3 px-2.5" onKeyDown={handleKeyDown}>
            <div class="text-14-medium text-text-base px-2.5">{language.t("dialog.model.unpaid.freeModels.title")}</div>
            <Show
              when={freeModels().length > 0}
              fallback={<div class="px-2.5 py-5 text-14-regular text-text-weak">No free OpenCode models are available.</div>}
            >
              <List
                class="[&_[data-slot=list-scroll]]:overflow-visible"
                ref={(ref) => (listRef = ref)}
                items={freeModels}
                current={model.current()}
                key={(x) => `${x.provider.id}:${x.id}`}
                onSelect={(x) => {
                  model.set(x ? { modelID: x.id, providerID: x.provider.id } : undefined, { recent: true })
                  // Only a real pick, never the list's own clear/deselect call. This
                  // dialog is reached only from the composer's unpaid-model prompt.
                  if (x) {
                    phCapture("model_selected", {
                      ...identityProps(),
                      surface: "composer",
                      provider_id: x.provider.id,
                      model_id: x.id,
                    })
                  }
                  dialog.close()
                }}
              >
                {(i) => (
                  <div class="w-full flex items-center gap-x-2.5">
                    <span>{i.name}</span>
                    <Tag>{language.t("model.tag.free")}</Tag>
                    <Show when={i.latest}><Tag>{language.t("model.tag.latest")}</Tag></Show>
                  </div>
                )}
              </List>
            </Show>
          </div>
          <div class="px-1.5 pb-1.5">
        <div class="w-full rounded-sm border border-border-weak-base bg-surface-raised-base">
          <div class="w-full flex flex-col items-start gap-4 px-1.5 pt-4 pb-4">
            <div class="px-2 text-14-medium text-text-base">{language.t("dialog.model.unpaid.addMore.title")}</div>
            <div class="w-full">
              <List
                class="w-full px-0"
                key={(p) => p.id}
                items={providers.popular}
                activeIcon="plus-small"
                sortBy={(a, b) => {
                  if (popularProviders.includes(a.id) && popularProviders.includes(b.id))
                    return popularProviders.indexOf(a.id) - popularProviders.indexOf(b.id)
                  return a.name.localeCompare(b.name)
                }}
                onSelect={(x) => {
                  if (!x) return
                  connect(x.id)
                }}
              >
                {(i) => (
                  <div class="w-full flex items-center gap-x-3">
                    <ProviderIcon data-slot="list-item-extra-icon" id={i.id} />
                    <span>{i.name}</span>
                    <Show when={i.id === "opencode"}>
                      <div class="text-14-regular text-text-weak">{language.t("dialog.provider.opencode.tagline")}</div>
                    </Show>
                    <Show when={i.id === "opencode"}>
                      <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                    </Show>
                    <Show when={i.id === "opencode-go"}>
                      <>
                        <div class="text-14-regular text-text-weak">
                          {language.t("dialog.provider.opencodeGo.tagline")}
                        </div>
                        <Tag>{language.t("dialog.provider.tag.recommended")}</Tag>
                      </>
                    </Show>
                    <Show when={i.id === "anthropic"}>
                      <div class="text-14-regular text-text-weak">{language.t("dialog.provider.anthropic.note")}</div>
                    </Show>
                  </div>
                )}
              </List>
              <Button
                variant="ghost"
                class="w-full justify-start px-[11px] py-3.5 gap-4.5 text-14-medium"
                icon="dot-grid"
                onClick={all}
              >
                {language.t("dialog.provider.viewAll")}
              </Button>
            </div>
          </div>
        </div>
          </div>
        </Match>
      </Switch>
    </Dialog>
  )
}

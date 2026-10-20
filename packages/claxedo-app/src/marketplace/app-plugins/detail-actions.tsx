import { Show, type JSX } from "solid-js"
import { useTranslator } from "@/i18n"
import { Button } from "@/ui"
import { marketplaceDictionary } from "../i18n"
import { OverflowItem, OverflowMenu } from "../view/overflow-menu"
import type { AppPluginActions } from "./actions"
import { MAIN_ACTION_LABEL, runMainAction } from "./main-action"
import { appPluginMainAction, appPluginUpdate, type AppPluginEntry } from "./model"

type ActionProps = { readonly entry: AppPluginEntry; readonly canManage: boolean; readonly actions: AppPluginActions }

function OrganizationMenu(props: ActionProps & { readonly busy: boolean }): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const install = () => props.entry.install
  const update = () => appPluginUpdate(props.entry)
  return (
    <Show when={install()}>
      {(installed) => (
        <OverflowMenu label={t("marketplace.moreActions", { name: props.entry.name })}>
          <Show when={update()}>
            {(version) => (
              <OverflowItem disabled={props.busy} onSelect={() => void props.actions.update(props.entry)}>
                {t("marketplace.action.updateTo", { version: version() })}
              </OverflowItem>
            )}
          </Show>
          <Show when={installed().active}>
            <OverflowItem
              disabled={props.busy}
              hint={installed().orgDefault ? undefined : t("marketplace.app.action.defaultOnHint")}
              onSelect={() => void props.actions.setOrganizationDefault(props.entry, !installed().orgDefault)}
            >
              {t(installed().orgDefault ? "marketplace.app.action.defaultOff" : "marketplace.app.action.defaultOn")}
            </OverflowItem>
            <OverflowItem disabled={props.busy} hint={t("marketplace.app.action.turnOffForOrganizationHint")} onSelect={() => void props.actions.setActiveForOrganization(props.entry, false)}>
              {t("marketplace.app.action.turnOffForOrganization")}
            </OverflowItem>
          </Show>
          <OverflowItem disabled={props.busy} hint={t("marketplace.app.action.uninstallHint")} onSelect={() => void props.actions.uninstall(props.entry)}>
            <span class="text-icon-critical-base">{t("marketplace.app.action.uninstall")}</span>
          </OverflowItem>
        </OverflowMenu>
      )}
    </Show>
  )
}

export function AppPluginDetailActions(props: ActionProps): JSX.Element {
  const t = useTranslator(marketplaceDictionary)
  const busy = () => props.actions.pending() === props.entry.id
  const main = () => appPluginMainAction(props.entry, props.canManage)
  const contrast = () => main() !== "turnOff"
  return (
    <Show when={main() || (props.canManage && props.entry.install)}>
      <div class="flex items-center gap-1.5 px-4 py-3">
        <Show when={main()}>
          {(action) => (
            <Button size="small" variant={contrast() ? "contrast" : "neutral"} disabled={busy()} onClick={() => void runMainAction(props.actions, action(), props.entry)}>
              {busy() ? t("marketplace.action.applying") : t(MAIN_ACTION_LABEL[action()])}
            </Button>
          )}
        </Show>
        <Show when={props.canManage}>
          <OrganizationMenu {...props} busy={busy()} />
        </Show>
      </div>
    </Show>
  )
}

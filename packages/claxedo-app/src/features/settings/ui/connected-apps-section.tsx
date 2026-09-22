import { createResource, createSignal, For, Show, type Component } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import {
  listConnectedApps,
  revokeConnectedApp,
  type ConnectedApp,
} from "@/features/settings/data/connected-apps-api"

export const ConnectedAppsSettingsSection: Component<{
  t: (key: string) => string
  list?: () => Promise<ConnectedApp[]>
  revoke?: (consentId: string) => Promise<void>
}> = (props) => {
  const list = props.list ?? listConnectedApps
  const revoke = props.revoke ?? revokeConnectedApp
  const [apps, { refetch }] = createResource(list)
  const [revoking, setRevoking] = createSignal<string>()
  const [failure, setFailure] = createSignal<string>()

  /**
   * Reading an errored resource throws, and this section renders inside a
   * dialog mounted from the app shell's owner — so a build whose consent
   * endpoint answers 404 threw past every boundary in between. The error is a
   * state of this list, not of the application.
   */
  const loadFailure = () => {
    const error: unknown = apps.error
    if (!error) return undefined
    if (error instanceof Error && error.message) return error.message
    if (typeof error === "string" && error) return error
    return props.t("settings.general.connectedApps.unavailable")
  }
  const rows = () => (loadFailure() ? [] : apps() ?? [])

  const remove = async (app: ConnectedApp) => {
    setRevoking(app.consentId)
    setFailure()
    try {
      await revoke(app.consentId)
      await refetch()
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Could not disconnect this application")
    } finally {
      setRevoking()
    }
  }

  return (
    <div class="flex flex-col gap-1">
      <h2 class="text-14-medium text-text-strong pb-2">{props.t("settings.general.section.connectedApps")}</h2>

      <div class="bg-surface-raised-base px-4 rounded-lg">
        <Show
          when={rows().length > 0}
          fallback={
            <p class="py-3 text-12-regular text-text-weak">
              {props.t("settings.general.connectedApps.empty")}
            </p>
          }
        >
          <For each={rows()}>
            {(app) => (
              <div class="flex items-center justify-between gap-4 py-3 border-b border-border-weak-base last:border-none">
                <div class="flex flex-col gap-0.5">
                  <span class="text-14-medium text-text-strong">{app.name ?? app.clientId}</span>
                  <span class="text-12-regular text-text-weak">{app.scopes.join(", ")}</span>
                </div>
                <Button
                  size="small"
                  variant="secondary"
                  disabled={revoking() !== undefined}
                  onClick={() => void remove(app)}
                >
                  {revoking() === app.consentId
                    ? props.t("settings.general.connectedApps.revoking")
                    : props.t("settings.general.connectedApps.revoke")}
                </Button>
              </div>
            )}
          </For>
        </Show>

        <Show when={loadFailure()}>
          {(message) => <p role="alert" class="pb-3 text-12-regular text-icon-critical-base">{message()}</p>}
        </Show>

        <Show when={failure()}>
          {(message) => <p role="alert" class="pb-3 text-12-regular text-icon-critical-base">{message()}</p>}
        </Show>
      </div>
    </div>
  )
}

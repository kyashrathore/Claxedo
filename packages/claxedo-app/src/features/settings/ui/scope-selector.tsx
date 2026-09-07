import { Select } from "@opencode-ai/ui/select"
import { createMemo, Show, type Component } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"

type WorkspaceChoice = { value: string; label: string }
type HarnessChoice = { value: string; selectionKey: string; label: string }

/**
 * Which workspace and which harness these settings are about.
 *
 * A model's visibility belongs to (the machine serving a workspace, the
 * harness), and one harness's catalog is not the other's, so Models asks the
 * pair rather than assuming it. Each picker appears only where there is a
 * choice to make: a select offering one option asks a question whose answer is
 * already on screen.
 */
export const SettingsScopeSelector: Component = () => {
  const language = useLanguage()
  const scope = useSettingsScope()

  const workspaceChoices = createMemo<WorkspaceChoice[]>(() =>
    scope.workspaces().map((option) => ({
      value: option.key,
      label: option.project === option.label ? option.label : `${option.project} · ${option.label}`,
    })))
  const harnessChoices = createMemo<HarnessChoice[]>(() =>
    scope.harnesses().map((option) => ({ value: encodeURIComponent(option.id), selectionKey: option.id, label: option.label })))

  const showWorkspaces = () => workspaceChoices().length > 1
  const showHarnesses = () => harnessChoices().length > 1
  const showEmptyWorkspaces = () => scope.workspaces().length === 0

  return (
    <Show when={showWorkspaces() || showHarnesses() || showEmptyWorkspaces()}>
      <div class="flex flex-wrap items-end gap-4" data-component="settings-scope-selector">
        <Show when={showWorkspaces() || showEmptyWorkspaces()}>
          <div class="flex flex-col gap-1.5">
            <span class="text-12-medium text-text-weak">{language.t("settings.scope.workspace.label")}</span>
            <Show
              when={showWorkspaces()}
              fallback={(
                <span class="text-12-regular text-text-weak" data-component="settings-scope-empty">
                  {scope.loading()
                    ? language.t("settings.scope.workspace.loading")
                    : language.t("settings.scope.workspace.empty")}
                </span>
              )}
            >
              <Select
                data-action="settings-scope-workspace"
                placeholder={language.t("settings.scope.workspace.label")}
                options={workspaceChoices()}
                current={workspaceChoices().find((option) => option.value === scope.workspace()?.key)}
                value={(option) => option.value}
                label={(option) => option.label}
                onSelect={(option) => {
                  if (!option) return
                  scope.selectWorkspace(option.value)
                }}
                variant="secondary"
                size="small"
                triggerVariant="settings"
                triggerStyle={{ "min-width": "200px" }}
              />
            </Show>
          </div>
        </Show>
        <Show when={showHarnesses()}>
          <div class="flex flex-col gap-1.5">
            <span class="text-12-medium text-text-weak">{language.t("settings.scope.harness.label")}</span>
            <Select
              data-action="settings-scope-harness"
              placeholder={language.t("settings.scope.harness.label")}
              options={harnessChoices()}
              current={harnessChoices().find((option) => option.selectionKey === scope.harness())}
              value={(option) => option.value}
              label={(option) => option.label}
              onSelect={(option) => {
                if (!option) return
                scope.selectHarness(option.selectionKey)
              }}
              variant="secondary"
              size="small"
              triggerVariant="settings"
              triggerStyle={{ "min-width": "180px" }}
            />
          </div>
        </Show>
      </div>
    </Show>
  )
}

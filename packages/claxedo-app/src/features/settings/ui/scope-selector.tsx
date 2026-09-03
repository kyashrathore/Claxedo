import { Select } from "@opencode-ai/ui/select"
import { createMemo, Show, type Component } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"

type WorkspaceChoice = { value: string; label: string }
type HarnessChoice = { value: string; label: string }

/**
 * Which workspace and which harness these settings are about.
 *
 * A provider catalog, the credentials behind it and a model's visibility all
 * belong to (the machine serving a workspace, the harness) — so this pair is
 * the first thing the Providers and Models surfaces ask, not something they
 * assume.
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
    scope.harnesses().map((option) => ({ value: option.id, label: option.label })))

  return (
    <div class="flex flex-wrap items-end gap-4" data-component="settings-scope-selector">
      <div class="flex flex-col gap-1.5">
        <span class="text-12-medium text-text-weak">{language.t("settings.scope.workspace.label")}</span>
        <Show
          when={scope.workspaces().length > 0}
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
      <div class="flex flex-col gap-1.5">
        <span class="text-12-medium text-text-weak">{language.t("settings.scope.harness.label")}</span>
        <Select
          data-action="settings-scope-harness"
          placeholder={language.t("settings.scope.harness.label")}
          options={harnessChoices()}
          current={harnessChoices().find((option) => option.value === scope.harness())}
          value={(option) => option.value}
          label={(option) => option.label}
          onSelect={(option) => {
            if (!option) return
            scope.selectHarness(option.value)
          }}
          variant="secondary"
          size="small"
          triggerVariant="settings"
          triggerStyle={{ "min-width": "180px" }}
        />
      </div>
    </div>
  )
}

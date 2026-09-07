import { For, Show, type Component } from "solid-js"
import { useLanguage } from "@/platform/i18n/provider"
import { type NativeHarnessId } from "@/platform/identity/harness-selection"
import { useSettingsScope } from "@/features/settings/scope/settings-scope"
import { SettingsAgentsSection } from "@/features/settings/ui/agents-section"
import { HarnessProvidersSection } from "@/features/settings/ui/harness-providers-section"

/**
 * The harnesses whose provider credentials Claxedo holds. Both are shown at
 * once rather than one at a time: a workspace can run either, and a login
 * connected under one of them is not a login under the other. The workspace
 * is the one in view — these credentials belong to the machine serving it.
 */
const CATALOG_SECTIONS: ReadonlyArray<{
  harness: NativeHarnessId
  titleKey: string
  descriptionKey?: string
}> = [
  { harness: "pi", titleKey: "settings.providers.section.pi", descriptionKey: "settings.providers.pi.description" },
  { harness: "opencode", titleKey: "settings.providers.section.opencode" },
]

export const SettingsProviders: Component = () => {
  const language = useLanguage()
  const scope = useSettingsScope()

  return (
    <div class="flex flex-col h-full overflow-y-auto no-scrollbar px-4 pb-10 sm:px-10 sm:pb-10">
      <div class="flex flex-col gap-4 pt-6 pb-8 max-w-[720px]">
        <div class="flex flex-col gap-1">
          <h2 class="text-18-medium text-text-strong">{language.t("settings.providers.title")}</h2>
          <p class="text-12-regular text-text-weak">{language.t("settings.providers.description")}</p>
        </div>
      </div>

      <div class="flex flex-col gap-8 max-w-[720px]">
        <SettingsAgentsSection />

        <Show
          when={scope.workspace()}
          fallback={(
            <p class="text-12-regular text-text-weak" data-component="providers-no-workspace">
              {scope.loading()
                ? language.t("settings.scope.workspace.loading")
                : language.t("settings.scope.workspace.empty")}
            </p>
          )}
        >
          <For each={CATALOG_SECTIONS}>
            {(section) => (
              <HarnessProvidersSection
                harness={section.harness}
                titleKey={section.titleKey}
                descriptionKey={section.descriptionKey}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  )
}

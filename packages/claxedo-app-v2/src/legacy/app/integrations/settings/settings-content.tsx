import { createMemo, on, Show, type Component } from "solid-js"
import { useSettingsSectionRegistry } from "@/app/integrations/settings/settings-sections-registry"
import { useLanguage } from "@/platform/i18n/provider"
import { SettingsSectionHeading } from "@/ui/controls/settings-list"

/** The open section's own panel, filling the workbench column. */
export const SettingsContent: Component<{ section: string }> = (props) => {
  const language = useLanguage()
  const sections = useSettingsSectionRegistry()
  const active = () => sections().find((entry) => entry.id === props.section)
  // Keyed on the section id alone. The registry recomputes whenever a product
  // flag or a contributed section settles, and a panel rebuilt on that would
  // drop the scroll position and any half-filled field in it; only moving to
  // another section is meant to replace what is drawn.
  const panel = createMemo(on(() => props.section, () => active()?.render()))

  return (
    <div class="flex h-full min-h-0 flex-1 flex-col overflow-y-auto" data-component="settings-content" data-section={props.section}>
      {/* One measure for every section, centred, so a wide window does not
          stretch a settings row the width of the screen. The sections keep
          their own vertical padding; this only bounds and centres them.
          `bg-inherit` carries the surface colour down to the sections that
          pin a header, which have nothing else to sit on while they scroll. */}
      <div class="mx-auto w-full max-w-[880px] bg-inherit px-4 sm:px-6">
        <Show when={active()?.heading}>
          {(heading) => (
            <SettingsSectionHeading
              title={heading().title}
              {...(heading().description === undefined ? {} : { description: heading().description })}
            />
          )}
        </Show>
        <Show
          when={panel()}
          fallback={(
            <p class="p-6 text-12-regular text-text-weak" data-component="settings-content-missing">
              {language.t("settings.scope.workspace.empty")}
            </p>
          )}
        >
          {panel()}
        </Show>
      </div>
    </div>
  )
}

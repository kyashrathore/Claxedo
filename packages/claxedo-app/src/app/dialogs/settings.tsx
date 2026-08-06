// Claxedo adds mobile settings navigation and Claxedo-owned terminal and sandbox tabs.
import { Component, createSignal } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Tabs } from "@opencode-ai/ui/tabs"
import { ClaxedoIcon as Icon } from "@/ui/controls/claxedo-icon"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useLanguage } from "@/platform/i18n/provider"
import { SettingsGeneral } from "@/features/settings/ui/general"
import { SettingsKeybinds } from "@/features/settings/ui/keybinds"
import { SettingsProviders } from "@/features/settings/ui/providers"
import { SettingsModels } from "@/features/settings/ui/models"
import { SettingsTerminals } from "@/features/settings/ui/terminals"
import { SettingsConnections } from "@/features/settings/ui/connections"
import { SandboxSettingsSection } from "@/features/settings/ui/sandbox-section"
import claxedoPkg from "../../../package.json"
import { RemoteAccessSurface, useRemoteAccessController } from "@/features/onboarding"
import { useServer } from "@/app/connection/server"
import { useNavigate } from "@solidjs/router"

export const DialogSettings: Component = () => {
  const language = useLanguage()
  const dialog = useDialog()
  const server = useServer()
  const navigate = useNavigate()
  const remoteAccess = useRemoteAccessController({ serverUrl: server.url })
  const [active, setActive] = createSignal("general")
  const [mobile, setMobile] = createSignal(false)

  return (
    <Dialog size="x-large" transition flush class="flex-1 claxedo-settings-dialog" aria-label={language.t("sidebar.settings")}>
      <div class="flex flex-col h-full min-h-0">
        <div class="hidden h-10 shrink-0 items-center justify-between border-b border-border-weak-base/60 px-3 max-sm:flex">
          <span class="text-[13px] font-medium text-text-base">Settings</span>
          <button
            type="button"
            aria-label="Close settings"
            class="flex size-7 items-center justify-center rounded-md border-none bg-transparent text-icon-weak-base transition-colors hover:bg-surface-base-hover hover:text-icon-base"
            onClick={() => dialog.close()}
          >
            <Icon name="close" size="small" />
          </button>
        </div>

        <Tabs
          orientation="vertical"
          variant="settings"
          value={active()}
          onChange={(value: string) => {
            setActive(value)
            setMobile(true)
          }}
          class="h-full min-h-0"
          classList={{
            "settings-dialog": true,
            "settings-mobile-menu": !mobile(),
            "settings-mobile-content": mobile(),
          }}
        >
          <Tabs.List>
            <div
              class="flex flex-col justify-between h-full w-full"
              onClick={(event) => {
                if ((event.target as HTMLElement).closest("[data-slot='tabs-trigger']")) {
                  setMobile(true)
                }
              }}
            >
              <div class="flex flex-col gap-3 w-full pt-3">
                <div class="flex flex-col gap-3">
                  <div class="flex flex-col gap-1.5">
                    <Tabs.SectionTitle>{language.t("settings.section.desktop")}</Tabs.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <Tabs.Trigger value="general">
                        <Icon name="sliders" />
                        {language.t("settings.tab.general")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="shortcuts">
                        <Icon name="keyboard" />
                        {language.t("settings.tab.shortcuts")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="terminals">
                        <Icon name="console" />
                        Terminals
                      </Tabs.Trigger>
                      <Tabs.Trigger value="devices">
                        <Icon name="link" />
                        Devices
                      </Tabs.Trigger>
                    </div>
                  </div>

                  <div class="flex flex-col gap-1.5">
                    <Tabs.SectionTitle>{language.t("settings.section.server")}</Tabs.SectionTitle>
                    <div class="flex flex-col gap-1.5 w-full">
                      <Tabs.Trigger value="providers">
                        <Icon name="providers" />
                        {language.t("settings.providers.title")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="models">
                        <Icon name="models" />
                        {language.t("settings.models.title")}
                      </Tabs.Trigger>
                      <Tabs.Trigger value="connections">
                        <Icon name="link" />
                        Connections
                      </Tabs.Trigger>
                      <Tabs.Trigger value="compute">
                        <Icon name="cloud-upload" />
                        Sandbox
                      </Tabs.Trigger>
                    </div>
                  </div>
                </div>
              </div>
              <div class="flex flex-col gap-1 pl-1 py-1 text-12-medium text-text-weak">
                <span>Claxedo</span>
                <span class="text-11-regular">v{claxedoPkg.version}</span>
              </div>
            </div>
          </Tabs.List>

          <div class="settings-mobile-back" onClick={() => setMobile(false)}>
            <Icon name="arrow-left" size="small" />
            <span>Settings</span>
          </div>

          <Tabs.Content value="general" class="no-scrollbar">
            <SettingsGeneral />
          </Tabs.Content>
          <Tabs.Content value="shortcuts" class="no-scrollbar">
            <SettingsKeybinds />
          </Tabs.Content>
          <Tabs.Content value="terminals" class="no-scrollbar">
            <SettingsTerminals />
          </Tabs.Content>
          <Tabs.Content value="devices" class="no-scrollbar">
            <div class="p-6">
              <RemoteAccessSurface
                availability={remoteAccess.availability()}
                workspaceLink={remoteAccess.workspaceLink()}
                devices={remoteAccess.devices.data ?? []}
                startAtLogin={remoteAccess.startAtLogin()}
                onStartAtLoginChange={(enabled) => void remoteAccess.setStartAtLogin(enabled)}
                onEnable={() => void remoteAccess.enable()}
                onSignIn={() => {
                  dialog.close()
                  navigate("/login")
                }}
                onRevoke={(hostId) => void remoteAccess.revoke(hostId)}
              />
            </div>
          </Tabs.Content>
          <Tabs.Content value="providers" class="no-scrollbar">
            <SettingsProviders />
          </Tabs.Content>
          <Tabs.Content value="models" class="no-scrollbar">
            <SettingsModels />
          </Tabs.Content>
          <Tabs.Content value="connections" class="no-scrollbar">
            <SettingsConnections />
          </Tabs.Content>
          <Tabs.Content value="compute" class="no-scrollbar">
            <SandboxSettingsSection />
          </Tabs.Content>
        </Tabs>
      </div>
    </Dialog>
  )
}

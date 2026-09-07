import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, For, onMount, type Component } from "solid-js"
import { DialogAIConnect, localHarnessChecks, type LocalHarnessStatus } from "@/features/settings/app-ports"
import { agentSetupStatus, listStoredCredentialProviders, runProviderDetect } from "@/features/settings/provider-detect"
import { SettingsList } from "@/features/settings/ui/list"
import { ProviderSetupRow } from "@/features/settings/ui/provider-setup-row"
import { useLanguage } from "@/platform/i18n/provider"

/** The brand mark each harness is recognised by; its login is the provider's. */
const AGENT_ICON: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
}

/**
 * The agent logins on the machine this app runs on.
 *
 * Machine-wide, so it sits outside the workspace/harness scope the catalog
 * sections read under: a Claude Code login is the same login whichever
 * workspace is selected.
 */
export const SettingsAgentsSection: Component<{ onConnected?: () => void | Promise<void> }> = (props) => {
  const language = useLanguage()
  const dialog = useDialog()
  const [detecting, setDetecting] = createSignal(false)
  const [stored, setStored] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [discovered, setDiscovered] = createSignal<readonly LocalHarnessStatus[]>([])

  const readStored = async () => {
    setStored(await listStoredCredentialProviders())
  }

  onMount(() => {
    void readStored().catch(() => undefined)
  })

  const detect = async () => {
    setDetecting(true)
    try {
      const result = await runProviderDetect()
      setStored(result.stored)
      setDiscovered(result.agents)
      await props.onConnected?.()
    } catch (err: unknown) {
      showToast({
        title: language.t("common.requestFailed"),
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDetecting(false)
    }
  }

  const connect = () => {
    void dialog.show(() => (
      <DialogAIConnect
        onConnected={async () => {
          await readStored()
          await props.onConnected?.()
        }}
      />
    ))
  }

  return (
    <div class="flex flex-col gap-3" data-component="agents-providers-section">
      <div class="flex items-start justify-between gap-4">
        <div class="flex flex-col gap-1">
          <h3 class="text-14-medium text-text-strong">{language.t("settings.providers.section.agents")}</h3>
          <p class="text-12-regular text-text-weak">{language.t("settings.providers.detect.description")}</p>
        </div>
        <Button
          size="small"
          variant="ghost"
          disabled={detecting()}
          data-action="settings-providers-detect"
          onClick={() => void detect()}
        >
          {detecting()
            ? language.t("settings.providers.detect.running")
            : language.t("settings.providers.detect.action")}
        </Button>
      </div>
      <SettingsList>
        <For each={[...localHarnessChecks()]}>
          {(check) => {
            const status = () => agentSetupStatus(check, stored(), discovered())
            return (
              <ProviderSetupRow
                id={AGENT_ICON[check.id] ?? check.id}
                name={check.label}
                status={status().status}
                detail={status().detail}
                providerId={check.providerIds[0]}
                harness={check.id}
                note={language.t("settings.providers.agents.sharedCredential")}
                onConnect={connect}
              />
            )
          }}
        </For>
      </SettingsList>
    </div>
  )
}

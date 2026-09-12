import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, For, onMount, type Component } from "solid-js"
import {
  localHarnessChecks,
  saveDiscoveredAIConnections,
  useGlobalSDK,
  useServerIsLocal,
  type LocalHarnessCheck,
  type LocalHarnessStatus,
} from "@/features/settings/app-ports"
import {
  agentInUse,
  agentSetupStatus,
  listEffectiveCredentials,
  listStoredCredentialProviders,
  runProviderDetect,
  type EffectiveCredential,
  type ProviderDetectResult,
} from "@/features/settings/provider-detect"
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
 * The provider id a pasted credential is stored under for each harness: the
 * one its native SDK driver resolves auth by, so a key connected here is the
 * key the next turn runs with.
 */
const AGENT_CONNECT_PROVIDER: Record<string, string> = {
  claude: "claude-sdk",
  codex: "codex-app-server",
  cursor: "cursor-sdk",
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
  const globalSDK = useGlobalSDK()
  const serverIsLocal = useServerIsLocal()
  const [detecting, setDetecting] = createSignal(false)
  const [stored, setStored] = createSignal<ReadonlySet<string>>(new Set<string>())
  const [discovered, setDiscovered] = createSignal<readonly LocalHarnessStatus[]>([])
  const [discovery, setDiscovery] = createSignal<Pick<ProviderDetectResult, "discoveryId" | "rows">>()
  const [effective, setEffective] = createSignal<ReadonlyMap<string, EffectiveCredential>>()

  const readStored = async () => {
    const [storedIds, inUse] = await Promise.all([listStoredCredentialProviders(), listEffectiveCredentials()])
    setStored(storedIds)
    setEffective(inUse)
  }

  /** A harness's bound provider ids plus the one its connect card stores under. */
  const providerIds = (check: LocalHarnessCheck): readonly string[] => {
    const connect = AGENT_CONNECT_PROVIDER[check.id]
    return connect && !(check.providerIds as readonly string[]).includes(connect) ? [...check.providerIds, connect] : check.providerIds
  }

  const inUseLabel = (check: LocalHarnessCheck) => {
    const known = effective()
    if (!known) return undefined
    const row = agentInUse({ providerIds: providerIds(check) }, known)
    if (!row) return language.t("settings.providers.agents.inUseMachine")
    return language.t("settings.providers.agents.inUse", { label: row.label ?? row.kind ?? row.providerId })
  }

  onMount(() => {
    void readStored().catch(() => undefined)
  })

  const fail = (err: unknown) => {
    showToast({
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  const detect = async () => {
    setDetecting(true)
    try {
      const result = await runProviderDetect()
      setStored(result.stored)
      setEffective(result.effective)
      setDiscovered(result.agents)
      setDiscovery({ discoveryId: result.discoveryId, rows: result.rows })
      await props.onConnected?.()
    } catch (err: unknown) {
      fail(err)
    } finally {
      setDetecting(false)
    }
  }

  /** The login the last scan found for this harness, when it is not stored yet. */
  const discoveredRow = (check: LocalHarnessCheck) =>
    discovery()?.rows.find((row) =>
      !row.alreadyConnected
      && row.probe?.state !== "broken"
      && row.providerIds.some((id) => (check.providerIds as readonly string[]).includes(id)))

  const useLogin = async (check: LocalHarnessCheck) => {
    const current = discovery()
    const row = discoveredRow(check)
    if (!current || !row) return
    try {
      await saveDiscoveredAIConnections({
        serverUrl: globalSDK.url,
        discoveryId: current.discoveryId,
        items: row.providerIds.map((providerId) => ({
          providerId,
          ...(row.accountId ? { accountId: row.accountId } : {}),
          scope: serverIsLocal() ? "local" : "shared",
        })),
      })
      await readStored()
      await props.onConnected?.()
    } catch (err: unknown) {
      fail(err)
    }
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
            const status = () => agentSetupStatus({ ...check, providerIds: providerIds(check) }, stored(), discovered())
            return (
              <ProviderSetupRow
                id={AGENT_ICON[check.id] ?? check.id}
                name={check.label}
                status={status().status}
                detail={status().detail}
                providerId={AGENT_CONNECT_PROVIDER[check.id] ?? check.providerIds[0]}
                harness={check.id}
                note={language.t("settings.providers.agents.sharedCredential")}
                inUse={inUseLabel(check)}
                onUseLogin={discoveredRow(check) ? () => useLogin(check) : undefined}
                onConnected={async () => {
                  await readStored()
                  await props.onConnected?.()
                }}
              />
            )
          }}
        </For>
      </SettingsList>
    </div>
  )
}

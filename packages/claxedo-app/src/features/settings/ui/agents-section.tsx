import { Button } from "@opencode-ai/ui/button"
import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, For, onMount, type Component } from "solid-js"
import {
  localHarnessChecks,
  saveDiscoveredAIConnections,
  useGlobalSDK,
  useServerIsLocal,
  verifyAIConnection,
  type LocalHarnessCheck,
  type LocalHarnessStatus,
} from "@/features/settings/app-ports"
import type { AIUsageWindow } from "@/features/onboarding/ai-connect-state"
import {
  accountIdentity,
  activateCredential,
  agentInUse,
  agentSetupStatus,
  harnessAccounts,
  listEffectiveCredentials,
  listStoredCredentials,
  runProviderDetect,
  storedCredentialProviders,
  type EffectiveCredential,
  type ProviderDetectResult,
  type StoredCredential,
} from "@/features/settings/provider-detect"
import { SettingsList } from "@/features/settings/ui/list"
import { ProviderSetupRow } from "@/features/settings/ui/provider-setup-row"
import { formatRelativeTime } from "@/lib/relative-time"
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
 * What the provider said about the credential a harness runs on, and when.
 * `broken` and `unknown` carry the scan's own sentence; the health values are
 * the verifier's.
 */
type LiveCheck = {
  at: number
  verdict: "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired" | "broken" | "unknown" | "missing"
  usage?: AIUsageWindow[]
  reason?: string
}

const VERDICT_KEY: Record<LiveCheck["verdict"], string> = {
  ok: "settings.providers.live.ok",
  auth_failed: "settings.providers.live.authFailed",
  no_billing: "settings.providers.live.noBilling",
  rate_capped: "settings.providers.live.rateCapped",
  expired: "settings.providers.live.expired",
  broken: "settings.providers.live.broken",
  unknown: "settings.providers.live.unknown",
  missing: "settings.providers.live.missing",
}

const WINDOW_KEY: Record<string, string> = {
  session: "settings.providers.window.session",
  weekly: "settings.providers.window.weekly",
  weekly_opus: "settings.providers.window.weeklyOpus",
}

function isHealth(value: string): value is Extract<LiveCheck["verdict"], "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"> {
  return value === "ok" || value === "auth_failed" || value === "no_billing" || value === "rate_capped" || value === "expired"
}

/** The scan's verdict for a harness, as the same shape a stored row's check produces. */
function scanCheck(status: LocalHarnessStatus | undefined, at: number): LiveCheck | undefined {
  if (!status) return undefined
  if (status.state === "working") return { at, verdict: "ok", ...(status.usage ? { usage: status.usage } : {}) }
  if (status.state === "broken") return { at, verdict: "broken", ...(status.detail ? { reason: status.detail } : {}) }
  if (status.state === "unverifiable") return { at, verdict: "unknown", ...(status.detail ? { reason: status.detail } : {}) }
  return { at, verdict: "missing" }
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
  const [stored, setStored] = createSignal<readonly StoredCredential[]>([])
  const [discovered, setDiscovered] = createSignal<readonly LocalHarnessStatus[]>([])
  const [discovery, setDiscovery] = createSignal<Pick<ProviderDetectResult, "discoveryId" | "rows">>()
  const [effective, setEffective] = createSignal<ReadonlyMap<string, EffectiveCredential>>()
  const [scannedAt, setScannedAt] = createSignal<number>()
  const [checks, setChecks] = createSignal<Record<string, LiveCheck>>({})
  const [checking, setChecking] = createSignal<string>()
  const [activating, setActivating] = createSignal<string>()

  const readStored = async () => {
    const [rows, inUse] = await Promise.all([listStoredCredentials(), listEffectiveCredentials()])
    setStored(rows)
    setEffective(inUse)
  }

  /** A harness's bound provider ids plus the one its connect card stores under. */
  const providerIds = (check: LocalHarnessCheck): readonly string[] => {
    const connect = AGENT_CONNECT_PROVIDER[check.id]
    return connect && !(check.providerIds as readonly string[]).includes(connect) ? [...check.providerIds, connect] : check.providerIds
  }

  const inUseRow = (check: LocalHarnessCheck) => {
    const known = effective()
    return known ? agentInUse({ providerIds: providerIds(check) }, known) : undefined
  }

  const inUseLabel = (check: LocalHarnessCheck) => {
    if (!effective()) return undefined
    const row = inUseRow(check)
    if (!row) return language.t("settings.providers.agents.inUseMachine")
    return language.t("settings.providers.agents.inUse", { label: row.label ?? row.kind ?? row.providerId })
  }

  /**
   * The freshest answer about the credential in use: a check made here, else
   * the verdict the server stored with a row, else what the last scan said
   * about the machine login.
   */
  const liveCheck = (check: LocalHarnessCheck): LiveCheck | undefined => {
    const own = checks()[check.id]
    if (own) return own
    const row = inUseRow(check)
    if (row) {
      if (row.health !== undefined && isHealth(row.health) && row.lastValidatedAt !== undefined) {
        return { at: row.lastValidatedAt, verdict: row.health }
      }
      return undefined
    }
    const at = scannedAt()
    return at === undefined ? undefined : scanCheck(discovered().find((status) => status.id === check.id), at)
  }

  const liveText = (live: LiveCheck) => {
    const verdict = language.t(VERDICT_KEY[live.verdict])
    const parts = [live.reason ? `${verdict}: ${live.reason}` : verdict]
    for (const window of live.usage ?? []) {
      const name = WINDOW_KEY[window.window]
      parts.push(language.t("settings.providers.live.window", {
        name: name ? language.t(name) : window.window,
        used: String(window.usedPercent),
      }))
    }
    parts.push(Date.now() - live.at < 60_000
      ? language.t("settings.providers.live.checkedNow")
      : language.t("settings.providers.live.checkedAt", { when: formatRelativeTime(live.at, language.locale()) }))
    return parts.join(" · ")
  }

  const liveLabel = (check: LocalHarnessCheck) => {
    const live = liveCheck(check)
    return live ? liveText(live) : undefined
  }

  /**
   * The accounts under one harness row. Make active is offered on Claude only:
   * a Codex switch rewrites the operator's own `~/.codex/auth.json` through the
   * app-server, so the list names the account and says the switch is not here
   * yet rather than offering one that damages the machine's login.
   */
  const accounts = (check: LocalHarnessCheck) =>
    harnessAccounts({ providerIds: providerIds(check) }, stored()).map((row) => {
      const identity = accountIdentity(row)
      return {
        id: row.id,
        name: row.label ?? row.kind ?? row.providerId,
        isActive: row.isActive,
        ...(identity === undefined ? {} : { detail: identity }),
        ...(row.health !== undefined && isHealth(row.health) && row.lastValidatedAt !== undefined
          ? { live: liveText({ at: row.lastValidatedAt, verdict: row.health }) }
          : {}),
        ...(row.expiresAt === undefined ? {} : {
          expiry: language.t("settings.providers.agents.accountExpires", {
            when: formatRelativeTime(row.expiresAt, language.locale()),
          }),
        }),
      }
    })

  const activate = async (id: string) => {
    setActivating(id)
    try {
      await activateCredential(id)
      await readStored()
    } catch (err: unknown) {
      fail(err)
    } finally {
      setActivating(undefined)
    }
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
      setScannedAt(Date.now())
      setChecks({})
      await props.onConnected?.()
    } catch (err: unknown) {
      fail(err)
    } finally {
      setDetecting(false)
    }
  }

  /**
   * Asks the provider about the credential this harness runs on. A stored row
   * is verified by id; the machine login is re-scanned, which probes it.
   */
  const runCheck = async (check: LocalHarnessCheck) => {
    setChecking(check.id)
    try {
      const row = inUseRow(check)
      if (!row) {
        await detect()
        return
      }
      try {
        const verified = await verifyAIConnection({ serverUrl: globalSDK.url, credentialId: row.id, providerId: row.providerId })
        setChecks((prev) => ({
          ...prev,
          [check.id]: { at: Date.now(), verdict: verified.result, ...(verified.usage ? { usage: verified.usage } : {}) },
        }))
      } catch (err: unknown) {
        setChecks((prev) => ({
          ...prev,
          [check.id]: { at: Date.now(), verdict: "unknown", reason: err instanceof Error ? err.message : String(err) },
        }))
      }
      await readStored()
    } finally {
      setChecking(undefined)
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
            const status = () => agentSetupStatus(
              { ...check, providerIds: providerIds(check) },
              storedCredentialProviders(stored()),
              discovered(),
            )
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
                live={liveLabel(check)}
                accounts={accounts(check)}
                onActivate={check.id === "claude" ? (id) => activate(id) : undefined}
                activateNote={check.id === "codex" ? language.t("settings.providers.agents.switchLater") : undefined}
                activating={activating()}
                onCheck={() => runCheck(check)}
                checking={checking() === check.id || detecting()}
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

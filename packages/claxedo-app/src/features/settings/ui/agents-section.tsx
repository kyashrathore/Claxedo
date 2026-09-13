import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, For, onMount, Show, type Component } from "solid-js"
import {
  localHarnessChecks,
  saveDiscoveredAIConnections,
  useGlobalSDK,
  useServerIsLocal,
  verifyAIConnection,
  type AIDiscoveryRow,
  type LocalHarnessCheck,
  type LocalHarnessStatus,
} from "@/features/settings/app-ports"
import type { AIUsageWindow } from "@/features/onboarding/ai-connect-state"
import {
  accountIdentity,
  activateCredential,
  agentInUse,
  harnessAccounts,
  listEffectiveCredentials,
  listStoredCredentials,
  removeCredential,
  runProviderDetect,
  type EffectiveCredential,
  type HarnessAccount,
  type ProviderDetectResult,
  type StoredCredential,
} from "@/features/settings/provider-detect"
import { SettingsList } from "@/features/settings/ui/list"
import {
  AgentHarnessRow,
  type AgentAccount,
  type AgentHeader,
  type AgentTone,
} from "@/features/settings/ui/agent-harness-row"
import { formatRelativeTime } from "@/lib/relative-time"
import { useLanguage } from "@/platform/i18n/provider"

/** The brand mark each harness is recognised by; its login is the provider's. */
const AGENT_ICON: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
}

/** Who rejected the login, named in the sentence that asks for a new one. */
const AGENT_VENDOR: Record<string, string> = {
  claude: "Anthropic",
  codex: "OpenAI",
  cursor: "Cursor",
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

/** The entry key the login found on this computer is listed under. */
const MACHINE = "machine"

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

/**
 * The verdicts only a different credential can answer. A rate cap is not one of
 * them — the same login works again once the window resets — and neither is a
 * check we could not make.
 */
const REJECTED: ReadonlySet<LiveCheck["verdict"]> = new Set(["auth_failed", "no_billing", "expired", "broken"])

/** The verdicts the vendor itself pronounced, which the sentence can name it for. */
const REJECTED_BY_VENDOR: ReadonlySet<LiveCheck["verdict"]> = new Set(["auth_failed", "broken"])

const WINDOW_KEY: Record<string, string> = {
  session: "settings.providers.window.session",
  weekly: "settings.providers.window.weekly",
  weekly_opus: "settings.providers.window.weeklyOpus",
}

function isHealth(value: string): value is Extract<LiveCheck["verdict"], "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired"> {
  return value === "ok" || value === "auth_failed" || value === "no_billing" || value === "rate_capped" || value === "expired"
}

function tone(verdict: LiveCheck["verdict"] | undefined): AgentTone {
  if (verdict === "ok") return "success"
  if (verdict !== undefined && REJECTED.has(verdict)) return "danger"
  return "neutral"
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
  const [scanning, setScanning] = createSignal(false)
  const [stored, setStored] = createSignal<readonly StoredCredential[]>([])
  const [discovered, setDiscovered] = createSignal<readonly LocalHarnessStatus[]>([])
  const [discovery, setDiscovery] = createSignal<Pick<ProviderDetectResult, "discoveryId" | "rows">>()
  const [effective, setEffective] = createSignal<ReadonlyMap<string, EffectiveCredential>>()
  const [scannedAt, setScannedAt] = createSignal<number>()
  /** Checks made here, by account id; they outrank the verdict the server stored. */
  const [accountChecks, setAccountChecks] = createSignal<Record<string, LiveCheck>>({})
  const [checking, setChecking] = createSignal<string>()
  const [selecting, setSelecting] = createSignal<string>()
  const [removing, setRemoving] = createSignal<string>()

  const fail = (err: unknown) => {
    showToast({
      title: language.t("common.requestFailed"),
      description: err instanceof Error ? err.message : String(err),
    })
  }

  /** A harness's bound provider ids plus the one its connect card stores under. */
  const providerIds = (check: LocalHarnessCheck): readonly string[] => {
    const connect = AGENT_CONNECT_PROVIDER[check.id]
    return connect && !(check.providerIds as readonly string[]).includes(connect) ? [...check.providerIds, connect] : check.providerIds
  }

  const accounts = (check: LocalHarnessCheck) => {
    const connect = AGENT_CONNECT_PROVIDER[check.id]
    return harnessAccounts(
      { providerIds: providerIds(check), ...(connect === undefined ? {} : { connectProviderId: connect }) },
      stored(),
    )
  }

  /** The login the last scan found for this harness, while it is only on disk. */
  const machineRow = (check: LocalHarnessCheck): AIDiscoveryRow | undefined =>
    discovery()?.rows.find((row) =>
      !row.alreadyConnected
      && row.probe?.state !== "broken"
      && row.providerIds.some((id) => (check.providerIds as readonly string[]).includes(id)))

  /**
   * The provider's last word on one stored account: a check made here first,
   * then the verdict the server holds against that row.
   */
  const accountCheck = (row: HarnessAccount): LiveCheck | undefined =>
    accountChecks()[row.id]
      ?? (row.health !== undefined && isHealth(row.health) && row.lastValidatedAt !== undefined
        ? { at: row.lastValidatedAt, verdict: row.health }
        : undefined)

  /**
   * The entry the harness runs on.
   *
   * The server's effective read is the authority — it names the row a session
   * will be handed — and the stored mark answers only where the host cannot
   * enumerate its store. With neither, the harness runs on whatever login its
   * own CLI holds on this machine.
   */
  const selectedKey = (check: LocalHarnessCheck): string | undefined => {
    const rows = accounts(check)
    const known = effective()
    const inUse = known ? agentInUse({ providerIds: providerIds(check) }, known) : undefined
    const match = inUse ? rows.find((row) => row.ids.includes(inUse.id)) : undefined
    if (match) return match.id
    const active = rows.find((row) => row.isActive)
    if (active) return active.id
    return machineRow(check) ? MACHINE : undefined
  }

  /** Never a bare provider id: a row that never got a name falls back to its fingerprint. */
  const accountLabel = (row: StoredCredential) =>
    row.label && row.label !== row.providerId ? row.label : accountIdentity(row) ?? row.kind ?? row.providerId

  const verdictWord = (live: LiveCheck | undefined) =>
    live ? language.t(VERDICT_KEY[live.verdict]) : language.t("settings.providers.agents.unchecked")

  const usageWords = (live: LiveCheck | undefined) =>
    (live?.usage ?? []).map((window) => {
      const name = WINDOW_KEY[window.window]
      return language.t("settings.providers.live.window", {
        name: name ? language.t(name) : window.window,
        used: String(window.usedPercent),
      })
    })

  const checkedWords = (live: LiveCheck) => Date.now() - live.at < 60_000
    ? language.t("settings.providers.live.checkedNow")
    : language.t("settings.providers.live.checkedAt", { when: formatRelativeTime(live.at, language.locale()) })

  const machineCheck = (check: LocalHarnessCheck) => {
    const at = scannedAt()
    return at === undefined ? undefined : scanCheck(discovered().find((status) => status.id === check.id), at)
  }

  const listedAccounts = (check: LocalHarnessCheck): AgentAccount[] => {
    const selected = selectedKey(check)
    const entries = accounts(check).map((row) => {
      const live = accountCheck(row)
      const identity = accountIdentity(row)
      const label = accountLabel(row)
      return {
        key: row.id,
        ids: row.ids,
        label,
        ...(identity === undefined || identity === label ? {} : { source: identity }),
        tone: tone(live?.verdict),
        status: verdictWord(live),
        ...(live === undefined ? {} : { when: checkedWords(live) }),
        selected: selected === row.id,
      }
    })
    const machine = machineRow(check)
    if (!machine) return entries
    const live = machineCheck(check)
    // Last by construction: every stored account is a choice the user made, and
    // this login is the standing fallback underneath all of them.
    return [...entries, {
      key: MACHINE,
      ids: [],
      label: language.t("settings.providers.agents.machineLogin"),
      source: language.t("settings.providers.agents.machineSource", { origin: machine.origin }),
      tone: tone(live?.verdict),
      status: verdictWord(live),
      selected: selected === MACHINE,
      machine: true,
    }]
  }

  const notSetUp = (): AgentHeader => ({
    tone: "neutral",
    sentence: language.t("settings.providers.agents.notSetUp"),
    action: { kind: "connect" },
  })

  const header = (check: LocalHarnessCheck): AgentHeader => {
    const selected = selectedKey(check)
    if (selected === undefined) return notSetUp()
    if (selected === MACHINE) {
      const live = machineCheck(check)
      return {
        tone: tone(live?.verdict),
        sentence: [language.t("settings.providers.agents.usingMachine"), verdictWord(live), ...usageWords(live)].join(" · "),
      }
    }
    const row = accounts(check).find((account) => account.id === selected)
    if (!row) return notSetUp()
    const live = accountCheck(row)
    const label = accountLabel(row)
    if (live && REJECTED.has(live.verdict)) {
      return {
        tone: "danger",
        sentence: REJECTED_BY_VENDOR.has(live.verdict)
          ? language.t("settings.providers.agents.headerRejected", { label, vendor: AGENT_VENDOR[check.id] ?? check.label })
          : language.t("settings.providers.agents.headerUnusable", { label, verdict: verdictWord(live) }),
        action: { kind: "reconnect", credentialId: row.id },
      }
    }
    return {
      tone: tone(live?.verdict),
      sentence: [
        language.t("settings.providers.agents.usingAccount", { label }),
        verdictWord(live),
        ...usageWords(live),
      ].join(" · "),
    }
  }

  /**
   * One scan of this machine plus a fresh read of the store. Everything that
   * changes what is stored ends here, so the machine-login entry appears and
   * disappears from the same read the header is derived from.
   */
  const scan = async () => {
    setScanning(true)
    try {
      const result = await runProviderDetect()
      setStored(result.stored)
      setEffective(result.effective)
      setDiscovered(result.agents)
      setDiscovery({ discoveryId: result.discoveryId, rows: result.rows })
      setScannedAt(Date.now())
      setAccountChecks({})
      await props.onConnected?.()
    } catch (err: unknown) {
      fail(err)
    } finally {
      setScanning(false)
    }
  }

  onMount(() => {
    void scan()
  })

  /**
   * Stores the login the scan found, then marks it. Saving alone would leave
   * the harness on whatever it ran on before, which is the entry the user just
   * clicked away from.
   */
  const useMachineLogin = async (check: LocalHarnessCheck) => {
    const current = discovery()
    const row = machineRow(check)
    if (!current || !row) return
    const saved = await saveDiscoveredAIConnections({
      serverUrl: globalSDK.url,
      discoveryId: current.discoveryId,
      items: row.providerIds.map((providerId) => ({
        providerId,
        ...(row.accountId ? { accountId: row.accountId } : {}),
        scope: serverIsLocal() ? "local" : "shared",
      })),
    })
    await activateCredential(saved.map((result) => result.credentialId))
  }

  const select = async (check: LocalHarnessCheck, account: AgentAccount) => {
    setSelecting(account.key)
    try {
      if (account.machine) await useMachineLogin(check)
      else await activateCredential(account.ids)
      await scan()
    } catch (err: unknown) {
      fail(err)
    } finally {
      setSelecting(undefined)
    }
  }

  const remove = async (ids: readonly string[]) => {
    const [first] = ids
    if (first === undefined) return
    setRemoving(first)
    try {
      await removeCredential(ids)
      await scan()
    } catch (err: unknown) {
      fail(err)
    } finally {
      setRemoving(undefined)
    }
  }

  /**
   * Asks the provider about one stored account. The check is made against the
   * first of its rows — the others are the same login under the harness's other
   * bindings, and the provider would answer each of them identically.
   */
  const check = async (ids: readonly string[]) => {
    const [first] = ids
    const row = stored().find((item) => item.id === first)
    if (!row) return
    setChecking(row.id)
    try {
      try {
        const verified = await verifyAIConnection({ serverUrl: globalSDK.url, credentialId: row.id, providerId: row.providerId })
        setAccountChecks((prev) => ({
          ...prev,
          [row.id]: { at: Date.now(), verdict: verified.result, ...(verified.usage ? { usage: verified.usage } : {}) },
        }))
      } catch (err: unknown) {
        setAccountChecks((prev) => ({
          ...prev,
          [row.id]: { at: Date.now(), verdict: "unknown", reason: err instanceof Error ? err.message : String(err) },
        }))
      }
      const [rows, inUse] = await Promise.all([listStoredCredentials(), listEffectiveCredentials()])
      setStored(rows)
      setEffective(inUse)
    } finally {
      setChecking(undefined)
    }
  }

  const scannedLabel = () => {
    const at = scannedAt()
    if (scanning() || at === undefined) return language.t("settings.providers.agents.scanning")
    return Date.now() - at < 60_000
      ? language.t("settings.providers.agents.scannedNow")
      : language.t("settings.providers.agents.scannedAt", { when: formatRelativeTime(at, language.locale()) })
  }

  return (
    <div class="flex flex-col gap-3" data-component="agents-providers-section">
      <div class="flex flex-col gap-1">
        <h3 class="text-14-medium text-text-strong">{language.t("settings.providers.section.agents")}</h3>
        <p class="flex items-center gap-1.5 text-12-regular text-text-weak">
          <span data-component="agents-scanned-at">{scannedLabel()}</span>
          <Show when={!scanning()}>
            <span aria-hidden="true">·</span>
            <button
              type="button"
              class="border-none bg-transparent p-0 text-12-regular text-text-interactive-base"
              data-action="settings-providers-rescan"
              onClick={() => void scan()}
            >
              {language.t("settings.providers.agents.rescan")}
            </button>
          </Show>
        </p>
      </div>
      <SettingsList>
        <For each={[...localHarnessChecks()]}>
          {(harness) => (
            <AgentHarnessRow
              id={AGENT_ICON[harness.id] ?? harness.id}
              name={harness.label}
              providerId={AGENT_CONNECT_PROVIDER[harness.id] ?? harness.providerIds[0]}
              harness={harness.id}
              header={header(harness)}
              accounts={listedAccounts(harness)}
              onSelect={(account) => select(harness, account)}
              selecting={selecting()}
              onCheck={(ids) => check(ids)}
              checking={checking()}
              onRemove={(ids) => remove(ids)}
              removing={removing()}
              onConnected={() => scan()}
            />
          )}
        </For>
      </SettingsList>
    </div>
  )
}

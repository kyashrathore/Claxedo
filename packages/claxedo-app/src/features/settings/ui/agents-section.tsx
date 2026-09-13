import { Spinner } from "@opencode-ai/ui/spinner"
import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, For, onMount, Show, type Component } from "solid-js"
import {
  localHarnessChecks,
  loadMachineLogins,
  useGlobalSDK,
  verifyAIConnection,
  type LocalHarnessCheck,
  type MachineLogin,
} from "@/features/settings/app-ports"
import type { AIUsageWindow } from "@/features/onboarding/ai-connect-state"
import {
  accountIdentity,
  activateCredential,
  activateMachineLogin,
  agentInUse,
  harnessAccounts,
  listEffectiveCredentials,
  listStoredCredentials,
  removeCredential,
  runProviderDetect,
  type EffectiveCredential,
  type HarnessAccount,
  type StoredCredential,
} from "@/features/settings/provider-detect"
import { SettingsList } from "@/features/settings/ui/list"
import {
  AgentHarnessRow,
  type AgentAccount,
} from "@/features/settings/ui/agent-harness-row"
import { HARNESS_CONNECT_PROVIDER } from "@/platform/identity/harness-catalog"
import { formatRelativeTime } from "@/lib/relative-time"
import { useLanguage } from "@/platform/i18n/provider"

/** The brand mark each harness is recognised by; its login is the provider's. */
const AGENT_ICON: Record<string, string> = {
  claude: "anthropic",
  codex: "openai",
  cursor: "cursor",
}

/** The entry key this computer's own login is listed under. */
const MACHINE = "machine"

/**
 * What the provider said about one stored account, and when. `unknown` carries
 * the failure's own sentence; the rest are the verifier's health values.
 */
type LiveCheck = {
  at: number
  verdict: "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired" | "unknown"
  usage?: AIUsageWindow[]
  reason?: string
}

const VERDICT_KEY: Record<LiveCheck["verdict"], string> = {
  ok: "settings.providers.live.ok",
  auth_failed: "settings.providers.live.authFailed",
  no_billing: "settings.providers.live.noBilling",
  rate_capped: "settings.providers.live.rateCapped",
  expired: "settings.providers.live.expired",
  unknown: "settings.providers.live.unknown",
}

const WINDOW_KEY: Record<string, string> = {
  session: "settings.providers.window.session",
  weekly: "settings.providers.window.weekly",
  weekly_opus: "settings.providers.window.weeklyOpus",
}

/** The verdicts only a different credential, or a fresh login, can answer. */
function unusable(verdict: LiveCheck["verdict"]) {
  return verdict === "auth_failed" || verdict === "no_billing" || verdict === "expired"
}

function isHealth(value: string): value is Exclude<LiveCheck["verdict"], "unknown"> {
  return value === "ok" || value === "auth_failed" || value === "no_billing" || value === "rate_capped" || value === "expired"
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
  const [scanning, setScanning] = createSignal(false)
  /** Whether the section's first read of this machine has come back, however it went. */
  const [opened, setOpened] = createSignal(false)
  const [stored, setStored] = createSignal<readonly StoredCredential[]>([])
  const [machineLogins, setMachineLogins] = createSignal<readonly MachineLogin[]>([])
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
    const connect = HARNESS_CONNECT_PROVIDER[check.id]
    return connect && !(check.providerIds as readonly string[]).includes(connect) ? [...check.providerIds, connect] : check.providerIds
  }

  const accounts = (check: LocalHarnessCheck) => {
    const connect = HARNESS_CONNECT_PROVIDER[check.id]
    return harnessAccounts(
      { providerIds: providerIds(check), ...(connect === undefined ? {} : { connectProviderId: connect }) },
      stored(),
    )
  }

  /** This computer's own login for the harness, when the harness reports one. */
  const machineLogin = (check: LocalHarnessCheck): MachineLogin | undefined =>
    machineLogins().find((login) => login.harness === check.id && login.state === "signed_in")

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
    return machineLogin(check) ? MACHINE : undefined
  }

  /**
   * Never a bare provider id, and never the scan's wording for the file a login
   * was read out of: a row with no name of its own falls back to its
   * fingerprint, and this computer's own login is named for being that.
   */
  const accountLabel = (row: StoredCredential) => {
    if (row.label && row.label !== row.providerId) return row.label
    const identity = accountIdentity(row)
    return identity?.readable ? identity.text : row.kind ?? row.providerId
  }

  const verdictWord = (live: LiveCheck) => language.t(VERDICT_KEY[live.verdict])

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

  /**
   * The second line of one entry, or nothing when the label already said it
   * all. An unchecked account says nothing here: "Not checked" is the absence
   * of news, and every row would carry it.
   */
  const detailWords = (live: LiveCheck | undefined, origin?: string) => {
    const words = [
      ...(origin === undefined ? [] : [origin]),
      ...usageWords(live),
      ...(live === undefined ? [] : [checkedWords(live)]),
    ]
    return words.length > 0 ? words.join(" · ") : undefined
  }

  /**
   * The machine login's second line: what the harness itself reported. The
   * windows where it has them, and otherwise who it is signed in as — Claude
   * Code has no headless usage read, so its row never carries a window.
   */
  const machineWords = (login: MachineLogin) => {
    const windows = (login.usage ?? []).map((window) => {
      const name = WINDOW_KEY[window.window]
      return language.t("settings.providers.live.window", {
        name: name ? language.t(name) : window.window,
        used: String(window.usedPercent),
      })
    })
    const words = windows.length > 0
      ? windows
      : [login.plan ? language.t("settings.providers.agents.machinePlan", { plan: login.plan }) : undefined, login.org]
        .filter((word): word is string => word !== undefined)
    return words.length > 0 ? words.join(" · ") : undefined
  }

  /** The provider's refusal, which the row draws as a ring rather than as text. */
  const refusedWord = (live: LiveCheck | undefined) =>
    live && unusable(live.verdict) ? verdictWord(live) : undefined

  const listedAccounts = (check: LocalHarnessCheck): AgentAccount[] => {
    const selected = selectedKey(check)
    const entries = accounts(check).map((row) => {
      const live = accountCheck(row)
      const identity = accountIdentity(row)
      const label = accountLabel(row)
      const readable = identity && identity.readable && identity.text !== label ? identity.text : undefined
      const detail = detailWords(live, readable)
      const refused = refusedWord(live)
      return {
        key: row.id,
        ids: row.ids,
        label,
        ...(detail === undefined ? {} : { detail }),
        ...(refused === undefined ? {} : { refused }),
        // An id the reader cannot match to an account is worth having and not
        // worth a line, so the row carries it where a full value belongs.
        ...(identity === undefined || identity.readable ? {} : { identity: identity.text }),
        selected: selected === row.id,
      }
    })
    const machine = machineLogin(check)
    if (!machine) return entries
    const detail = machineWords(machine)
    // Last by construction: every stored account is a choice the user made, and
    // this login is the standing fallback underneath all of them.
    return [...entries, {
      key: MACHINE,
      ids: [],
      label: machine.email ?? language.t("settings.providers.agents.machineLogin"),
      ...(detail === undefined ? {} : { detail }),
      selected: selected === MACHINE,
      machine: true,
    }]
  }

  /**
   * One round of asking every harness on this machine what it is signed in as,
   * plus a fresh read of the store. Everything that changes what is stored ends
   * here, so the machine-login entry appears and disappears from the same read
   * the header is derived from. Local and cheap: no provider is called.
   */
  const scan = async () => {
    setScanning(true)
    try {
      const result = await runProviderDetect()
      setStored(result.stored)
      setEffective(result.effective)
      setMachineLogins(result.machineLogins)
      setScannedAt(Date.now())
      setAccountChecks({})
      await props.onConnected?.()
    } catch (err: unknown) {
      fail(err)
    } finally {
      setScanning(false)
      setOpened(true)
    }
  }

  onMount(() => {
    void scan()
  })

  const select = async (check: LocalHarnessCheck, account: AgentAccount) => {
    setSelecting(account.key)
    try {
      const machine = account.machine ? machineLogin(check) : undefined
      // Nothing is stored: the harness runs on its own login exactly when no
      // stored account of its providers carries the mark.
      if (machine) await activateMachineLogin(machine.providerIds)
      else if (!account.machine) await activateCredential(account.ids)
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
   * Asks again about one entry. A stored account is put to its provider, and
   * the check is made against the first of its rows — the others are the same
   * login under the harness's other bindings, and the provider would answer
   * each of them identically. This computer's own login is put to its harness,
   * which is the only thing that knows about it.
   */
  const check = async (harness: LocalHarnessCheck, account: AgentAccount) => {
    if (account.machine) {
      setChecking(account.key)
      try {
        const reread = await loadMachineLogins({ serverUrl: globalSDK.url, harness: harness.id })
        setMachineLogins((prev) => [...prev.filter((login) => login.harness !== harness.id), ...reread])
      } catch (err: unknown) {
        fail(err)
      } finally {
        setChecking(undefined)
      }
      return
    }
    const row = stored().find((item) => item.id === account.ids[0])
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

  /**
   * The header's one line. Before the first read comes back the section has no
   * rows to head, so this is the whole of what it says; after it, a Rescan runs
   * under the rows that are already on screen and only this line changes.
   */
  const scannedLabel = () => {
    const at = scannedAt()
    if (!opened()) return language.t("settings.providers.agents.scanning")
    if (scanning()) return language.t("settings.providers.agents.rescanning")
    if (at === undefined) return language.t("settings.providers.agents.scanFailed")
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
      {/*
        Nothing is drawn until the first read comes back. The harness list is
        known before it, so rows would appear at once and then rearrange as the
        accounts and the machine logins land under them — a first frame the
        reader can act on and that is not the answer.
      */}
      <Show
        when={opened()}
        fallback={(
          <div class="flex items-center gap-2 py-3 text-12-regular text-text-weak" data-component="agents-scanning">
            <Spinner class="size-4" />
            <span>{language.t("settings.providers.agents.scanning")}</span>
          </div>
        )}
      >
      <SettingsList>
        <For each={[...localHarnessChecks()]}>
          {(harness) => (
            <AgentHarnessRow
              id={AGENT_ICON[harness.id] ?? harness.id}
              name={harness.label}
              providerId={HARNESS_CONNECT_PROVIDER[harness.id] ?? harness.providerIds[0]}
              harness={harness.id}
              accounts={listedAccounts(harness)}
              onSelect={(account) => select(harness, account)}
              selecting={selecting()}
              onCheck={(account) => check(harness, account)}
              checking={checking()}
              onRemove={(ids) => remove(ids)}
              removing={removing()}
              onConnected={() => scan()}
            />
          )}
        </For>
      </SettingsList>
      </Show>
    </div>
  )
}

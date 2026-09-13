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
 * How far a machine login that drives only part of its harness reaches, for the
 * harnesses where the difference is the user's to know. The server says which
 * bindings the login serves; these are the words for it.
 */
const MACHINE_REACH: Record<string, readonly string[]> = {
  cursor: ["settings.providers.agents.machineCursorAcp", "settings.providers.agents.machineCursorSdkKey"],
}

/** Whether the harness runs on bindings this login cannot drive. */
function partialMachineLogin(login: MachineLogin) {
  return login.serves !== undefined && login.serves.length < login.providerIds.length
}

type LiveVerdict = "ok" | "auth_failed" | "no_billing" | "rate_capped" | "expired" | "unknown"

/**
 * What the provider said about one stored account, and when. `unknown` carries
 * the failure's own sentence; the rest are the verifier's health values. A
 * stored row can hold a usage read and no verdict, so the verdict is optional.
 */
type LiveCheck = {
  at: number
  verdict?: LiveVerdict
  usage?: AIUsageWindow[]
  reason?: string
}

const VERDICT_KEY: Record<LiveVerdict, string> = {
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
function unusable(verdict: LiveVerdict) {
  return verdict === "auth_failed" || verdict === "no_billing" || verdict === "expired"
}

function isHealth(value: string): value is Exclude<LiveVerdict, "unknown"> {
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

  /** What this harness said about its own login, in whichever of the four states. */
  const machineLogin = (check: LocalHarnessCheck): MachineLogin | undefined =>
    machineLogins().find((login) => login.harness === check.id)

  /**
   * The provider's last word on one stored account: a check made here first,
   * then what the server holds against that row — its verdict, and the plan
   * windows it last read.
   *
   * The windows are the last words on the line, and they are the ones that move
   * between reads, so "Checked" names the read that produced them; the verdict's
   * own time stands in only for a row that has none.
   */
  const accountCheck = (row: HarnessAccount): LiveCheck | undefined => {
    const live = accountChecks()[row.id]
    if (live) return live
    const verdict = row.health !== undefined && isHealth(row.health) ? row.health : undefined
    if (verdict === undefined && row.usage === undefined) return undefined
    const at = row.usage === undefined ? row.lastValidatedAt : row.usageAt ?? row.lastValidatedAt
    if (at === undefined) return undefined
    return {
      at,
      ...(verdict === undefined ? {} : { verdict }),
      ...(row.usage === undefined ? {} : { usage: row.usage }),
    }
  }

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

  const windowWords = (windows: readonly AIUsageWindow[] | undefined) =>
    (windows ?? []).map((window) => {
      const name = WINDOW_KEY[window.window]
      return language.t("settings.providers.live.window", {
        name: name ? language.t(name) : window.window,
        used: String(window.usedPercent),
      })
    })

  const checkedWords = (at: number) => Date.now() - at < 60_000
    ? language.t("settings.providers.live.checkedNow")
    : language.t("settings.providers.live.checkedAt", { when: formatRelativeTime(at, language.locale()) })

  /**
   * The second line of one entry, or nothing when the label already said it
   * all. An unchecked account says nothing here: "Not checked" is the absence
   * of news, and every row would carry it.
   */
  const detailWords = (live: LiveCheck | undefined, origin?: string) => {
    const words = [
      ...(origin === undefined ? [] : [origin]),
      ...windowWords(live?.usage),
      ...(live === undefined ? [] : [checkedWords(live.at)]),
    ]
    return words.length > 0 ? words.join(" · ") : undefined
  }

  /**
   * The machine login's second line: how far the login reaches, then what the
   * harness itself reported — its quota windows where it has them, and
   * otherwise the plan and organization it named.
   *
   * A harness answering now is its own timestamp; the server sends `usageAt`
   * only for windows it had already stored, which are the ones whose age is
   * worth a word.
   */
  const machineWords = (login: MachineLogin, check: LocalHarnessCheck) => {
    if (login.state === "absent") return language.t("settings.providers.agents.machineNotInstalled")
    if (login.state === "signed_out") {
      return language.t("settings.providers.agents.machineSignedOut", { command: check.signIn })
    }
    if (login.state === "unknown") return login.detail ?? language.t("settings.providers.agents.machineUnknown")
    const windows = windowWords(login.usage)
    const identity = windows.length > 0
      ? windows
      : [login.plan ? language.t("settings.providers.agents.machinePlan", { plan: login.plan }) : undefined, login.org]
        .filter((word): word is string => word !== undefined)
    const words = [
      ...reachWords(login),
      ...identity,
      ...(login.usageAt === undefined ? [] : [checkedWords(login.usageAt)]),
    ]
    return words.length > 0 ? words.join(" · ") : undefined
  }

  /**
   * What a login that drives only part of its harness reaches, and what the
   * rest needs instead. One row covers every binding a harness resolves auth
   * through, so without this the Cursor row reads as if signing the CLI in were
   * enough for the native SDK too.
   */
  const reachWords = (login: MachineLogin) =>
    partialMachineLogin(login) ? (MACHINE_REACH[login.harness] ?? []).map((key) => language.t(key)) : []

  /** The provider's refusal, which the row draws as a ring rather than as text. */
  const refusedWord = (live: LiveCheck | undefined) => {
    const verdict = live?.verdict
    return verdict !== undefined && unusable(verdict) ? language.t(VERDICT_KEY[verdict]) : undefined
  }

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
    const detail = machineWords(machine, check)
    const stranded = machine.state === "absent" ? undefined : strandedBinding(machine, check)
    // Listed in every state, because choosing it is the withdrawal of a stored
    // account rather than a login: a user whose harness is signed out still
    // needs to be able to say "run on whatever that CLI holds" and then go and
    // sign in to it. The one state that cannot be chosen is a CLI that is not
    // there, which no choice of ours can make runnable.
    //
    // Last by construction: every stored account is a choice the user made, and
    // this login is the standing fallback underneath all of them.
    return [...entries, {
      key: MACHINE,
      ids: [],
      label: machine.state === "signed_in" && machine.email
        ? machine.email
        : language.t("settings.providers.agents.machineLogin"),
      ...(detail === undefined ? {} : { detail }),
      selected: selected === MACHINE,
      machine: true,
      ...(machine.state === "absent" || stranded ? { disabled: true } : {}),
      ...(stranded ? { disabledReason: language.t("settings.providers.agents.machineStrands", { name: check.label }) } : {}),
    }]
  }

  /**
   * Whether choosing this login would strand the binding the harness runs on.
   *
   * Choosing it withdraws the active mark from every one of the harness's
   * bindings at once, and a binding the login cannot drive has nothing to fall
   * back to: Cursor's SDK path would lose its stored key and refuse the next
   * turn outright, which is not a trade the row can offer as a radio button.
   */
  const strandedBinding = (login: MachineLogin, check: LocalHarnessCheck) => {
    const serves = login.serves
    if (serves === undefined) return false
    const known = effective()
    const inUse = known ? agentInUse({ providerIds: providerIds(check) }, known) : undefined
    return inUse !== undefined && !serves.includes(inUse.providerId)
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
        const reread = await loadMachineLogins({ serverUrl: globalSDK.url, harness: harness.id, fresh: true })
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

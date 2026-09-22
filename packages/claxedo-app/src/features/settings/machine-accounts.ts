import { showToast } from "@opencode-ai/ui/toast"
import { createSignal, onMount } from "solid-js"
import { createSimpleContext } from "@opencode-ai/ui/context"
import {
  loadMachineLogins,
  useGlobalSDK,
  verifyAIConnection,
  type LocalHarnessCheck,
  type MachineLogin,
} from "@/features/settings/app-ports"
import type { QuotaWindow } from "@claxedo/usage-contract"
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
import type { AgentAccount } from "@/features/settings/ui/agent-harness-row"
import { bindingIdsForHarness } from "@/platform/identity/harness-catalog"
import {
  accountReach,
  isRefusal,
  isStoredVerdict,
  isUnavailable,
  readAccountDelivery,
  VERDICT_KEY,
  WINDOW_KEY,
  type ProviderVerdict,
} from "@/ui/controls/account-status"
import { formatRelativeTime } from "@/lib/relative-time"
import { readPercent } from "@/lib/percent"
import { useLanguage } from "@/platform/i18n/provider"

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

/**
 * Whether the harness runs on bindings this login cannot drive.
 *
 * Measured against the harness's own bindings rather than every provider id it
 * resolves auth through: a vendor key stored under the harness is that vendor's
 * models, and counting it read Claude Code's complete login — which drives both
 * of its bindings — as partial.
 */
function partialMachineLogin(login: MachineLogin) {
  const serves = login.serves
  return serves !== undefined && bindingIdsForHarness(login.harness).some((id) => !serves.includes(id))
}

/**
 * What the provider said about one stored account, and when. `unknown` carries
 * the failure's own sentence; the rest are the verifier's health values. A
 * stored row can hold a usage read and no verdict, so the verdict is optional.
 */
type LiveCheck = {
  at: number
  verdict?: ProviderVerdict
  usage?: QuotaWindow[]
  reason?: string
}

/**
 * The agent logins on the machine this app runs on.
 *
 * Machine-wide, so it sits outside the workspace/harness scope the catalog
 * sections read under: a Claude Code login is the same login whichever
 * workspace is selected.
 */

/**
 * Every agent login on the machine this app runs on, read once.
 *
 * Machine-wide, so it sits outside the workspace/harness scope the catalog
 * sections read under: a Claude Code login is the same login whichever
 * workspace is selected. One owner rather than one per harness section,
 * because asking a harness is not free — Codex answers through its app-server,
 * which reads the plan windows from the vendor — and three sections drawing
 * their own rows would each pay for it.
 */
const machineAccountsInput = {
  name: "MachineAccounts",
  gate: true,
  init: (props: { onConnected?: () => void | Promise<void> }) => {

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

    const accounts = (check: LocalHarnessCheck) =>
      harnessAccounts({ providerIds: check.providerIds, connectProviderId: check.connectProvider }, stored())

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
      const verdict = row.health !== undefined && isStoredVerdict(row.health) ? row.health : undefined
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
      const inUse = known ? agentInUse({ providerIds: check.providerIds }, known) : undefined
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

    const windowWords = (windows: readonly QuotaWindow[] | undefined) =>
      (windows ?? []).map((window) => {
        const name = WINDOW_KEY[window.window]
        return language.t("settings.providers.live.window", {
          name: name ? language.t(name) : window.window,
          used: String(readPercent(window.usedPercent)),
        })
      })

    /**
     * The provider's answer, in words, whatever it was: a check that never
     * reached the provider included, because a fresh read time beside nothing
     * else reads as a check that succeeded.
     */
    const verdictWords = (live: LiveCheck | undefined) => {
      if (live?.verdict === undefined) return []
      return [language.t(VERDICT_KEY[live.verdict]), ...(live.reason === undefined ? [] : [live.reason])]
    }

    /**
     * The second line of one entry, or nothing when the label already said it
     * all. An unchecked account says nothing here: "Not checked" is the absence
     * of news, and every row would carry it. When the read happened is not part
     * of the sentence — the row lines that up down its own right-hand column.
     */
    const detailWords = (live: LiveCheck | undefined, origin?: string) => {
      const words = [
        ...(origin === undefined ? [] : [origin]),
        ...verdictWords(live),
        ...windowWords(live?.usage),
      ]
      return words.length > 0 ? words.join(" · ") : undefined
    }

    /**
     * The machine login's second line: what the harness itself reported — its
     * quota windows where it has them, and otherwise the plan and organization
     * it named.
     */
    const machineWords = (login: MachineLogin, check: LocalHarnessCheck) => {
      if (login.state === "absent") return language.t("settings.providers.agents.machineNotInstalled")
      if (login.state === "signed_out") {
        return language.t("settings.providers.agents.machineSignedOut", { command: check.signIn })
      }
      if (login.state === "unknown") return login.detail ?? language.t("settings.providers.agents.machineUnknown")
      const windows = windowWords(login.usage)
      if (windows.length > 0) return windows.join(" · ")
      const identity = [
        login.plan ? language.t("settings.providers.agents.machinePlan", { plan: login.plan }) : undefined,
        login.org,
      ].filter((word): word is string => word !== undefined)
      return identity.length > 0 ? identity.join(" · ") : undefined
    }

    /**
     * What a login that drives only part of its harness reaches, and what the
     * rest needs instead. One row covers every binding a harness resolves auth
     * through, so without this the Cursor row reads as if signing the CLI in were
     * enough for the native SDK too.
     */
    const reachWords = (login: MachineLogin) =>
      partialMachineLogin(login) ? (MACHINE_REACH[login.harness] ?? []).map((key) => language.t(key)) : []

    const refused = (live: LiveCheck | undefined) => live?.verdict !== undefined && isRefusal(live.verdict)

    /**
     * A working login the provider will not serve right now, in the provider's
     * own words. Nothing the user can connect answers it, so it is a mark on
     * the row rather than another Reconnect.
     */
    const unavailableWords = (live: LiveCheck | undefined) =>
      live?.verdict !== undefined && isUnavailable(live.verdict) ? verdictWords(live).join(" · ") : undefined

    const listedAccounts = (check: LocalHarnessCheck): AgentAccount[] => {
      const selected = selectedKey(check)
      const entries = accounts(check).map((row) => {
        const live = accountCheck(row)
        const identity = accountIdentity(row)
        const label = accountLabel(row)
        const readable = identity && identity.readable && identity.text !== label ? identity.text : undefined
        const detail = detailWords(live, readable)
        const alert = unavailableWords(live)
        return {
          key: row.id,
          ids: row.ids,
          label,
          ...(detail === undefined ? {} : { detail }),
          ...(alert === undefined ? {} : { alert }),
          ...(live === undefined ? {} : { checkedAt: live.at }),
          ...(refused(live) ? { refused: true as const } : {}),
          // An id the reader cannot match to an account is worth having and not
          // worth a line, so the row carries it where a full value belongs.
          ...(identity === undefined || identity.readable ? {} : { identity: identity.text }),
          reach: accountReach(row.delivery),
          selected: selected === row.id,
        }
      })
      const machine = machineLogin(check)
      if (!machine) return entries
      const detail = machineWords(machine, check)
      const stranded = machine.state === "absent" ? undefined : strandedBinding(machine, check)
      const note = [
        ...reachWords(machine),
        ...(stranded ? [language.t("settings.providers.agents.machineStrands", { name: check.label })] : []),
      ].join(" · ")
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
        ...(machine.state === "unknown" && detail !== undefined ? { alert: detail } : {}),
        ...(machine.usageAt === undefined ? {} : { checkedAt: machine.usageAt }),
        ...(note === "" ? {} : { note }),
        reach: accountReach(readAccountDelivery(machine)),
        selected: selected === MACHINE,
        machine: true,
        ...(machine.state === "absent" || stranded ? { disabled: true } : {}),
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
      const inUse = known ? agentInUse({ providerIds: check.providerIds }, known) : undefined
      if (inUse === undefined) return false
      // A vendor key was never this login's to replace: withdrawing its mark hands
      // the harness back to the CLI login, which is the whole point of the row.
      return bindingIdsForHarness(login.harness).includes(inUse.providerId) && !serves.includes(inUse.providerId)
    }

    /**
     * One round of asking every harness on this machine what it is signed in as,
     * plus a fresh read of the store. Everything that changes what is stored ends
     * here, so the machine-login entry appears and disappears from the same read
     * the header is derived from. Asking a harness is not free — Codex answers
     * through its app-server, which reads the plan windows from the vendor — so
     * this runs on mount, on Rescan, and after a write, never on a render.
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

    return {
      scanning,
      opened,
      scannedLabel,
      scan,
      listedAccounts,
      select,
      selecting,
      check,
      checking,
      remove,
      removing,
    }
  },
}

export const { use: useMachineAccounts, provider: MachineAccountsProvider } = createSimpleContext<
  ReturnType<typeof machineAccountsInput.init>,
  { onConnected?: () => void | Promise<void> }
>(machineAccountsInput)

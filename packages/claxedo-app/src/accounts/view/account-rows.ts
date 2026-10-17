import { createMemo, type Accessor } from "solid-js"
import { useAccess } from "@/access"
import { useI18n } from "@/i18n"
import { useWindowName } from "@/usage"
import { machineLoginWords, orgAccountWords, storedAccountWords, type AccountWords } from "../account-words"
import { useAccountsText } from "../i18n"
import { harnessAccounts, machineLoginOf, ORG_ACCOUNT_KEY, selectedAccountKey, type AccountsSnapshot, type Harness } from "../model"
import type { Accounts } from "../store"

export function useAccountRows(harness: Accessor<Harness>, snapshot: Accessor<AccountsSnapshot>, accounts: Accessor<Accounts>): Accessor<readonly AccountWords[]> {
  const access = useAccess()
  const t = useAccountsText()
  const i18n = useI18n()
  const windowName = useWindowName()
  return createMemo((): AccountWords[] => {
    const words = { t, windowName, machineName: accounts().machineName(), locale: i18n.intlTag() }
    const live = accounts().liveChecks()
    const stored = harnessAccounts(harness(), snapshot().stored).map((row) => storedAccountWords(words, row, live[row.id]))
    const login = machineLoginOf(harness(), snapshot())
    const chosen = selectedAccountKey(harness(), snapshot()) === ORG_ACCOUNT_KEY
    const org = orgAccountWords(words, harness(), snapshot(), chosen, access.can("accounts.manageOrg", snapshot().sources), live)
    return [...stored, ...(login ? [machineLoginWords(words, login, harness(), snapshot())] : []), ...(org ? [org] : [])]
  })
}

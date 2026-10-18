import { definePlugin, type PluginApi, type SurfaceChannel, type SurfaceProgram } from "@claxedo/plugin-api"
import {
  addExpense,
  addParticipant,
  balances,
  deleteExpense,
  formatMoney,
  participantName,
  removeParticipant,
  seedTrip,
  setBudgets,
  setCurrency,
  settle,
  type Trip,
  type TripResult,
} from "./model"
import { categoryBudgets, changedEntries, displayEntries, emptyDraft, initialData, openingMessages, participantPickers, replaceComponents, slotBody, update, type ErrorSlot } from "./surface"

const PAGE_ID = "budget-split"

function localIsoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function settlementText(trip: Trip): string {
  const transfers = settle(balances(trip))
  if (transfers.length === 0) return "Everyone is square."
  return transfers.map((transfer) => `${participantName(trip, transfer.from)} pays ${participantName(trip, transfer.to)} ${formatMoney(transfer.amount, trip.currency)}`).join("; ")
}

function openBudget(api: PluginApi, state: { trip: Trip }, channel: SurfaceChannel): SurfaceProgram {
  const { surfaceId } = channel
  const dates = new Intl.DateTimeFormat(api.context.locale, { month: "short", day: "numeric", timeZone: "UTC" })
  const view = () => displayEntries(state.trip, (iso) => dates.format(new Date(`${iso}T00:00:00Z`)))
  let shown = view()
  channel.send(...openingMessages(surfaceId, state.trip, initialData(state.trip, shown, localIsoDate(new Date()))))

  const refresh = () => {
    const next = view()
    const messages = changedEntries(surfaceId, shown, next)
    shown = next
    if (messages.length > 0) channel.send(...messages)
  }

  const shownErrors = new Set<ErrorSlot>()
  const showError = (slot: ErrorSlot, error: { title: string; text: string } | undefined) => {
    if (error) channel.send(update(surfaceId, `/errors/${slot}`, error))
    if (shownErrors.has(slot) !== (error !== undefined)) channel.send(replaceComponents(surfaceId, [slotBody(slot, error !== undefined)]))
    if (error) shownErrors.add(slot)
    else shownErrors.delete(slot)
  }

  const commit = (result: TripResult, failure: string, slot: ErrorSlot): boolean => {
    if (!result.ok) {
      showError(slot, { title: failure, text: result.error })
      return false
    }
    showError(slot, undefined)
    state.trip = result.trip
    return true
  }

  const sendBudgets = () => channel.send(...categoryBudgets(state.trip).map((budget, index) => update(surfaceId, `/categories/${index}/budget`, budget)))

  return {
    async action(action) {
      const context = action.context
      switch (action.name) {
        case "setCurrency": {
          const result = setCurrency(state.trip, context.currency)
          if (!commit(result, "Currency not changed", "budgets") || !result.ok) return
          channel.send(update(surfaceId, "/currency", [state.trip.currency]))
          sendBudgets()
          api.ui.toast({ kind: "info", title: `Showing ${state.trip.currency}`, description: `${result.message} Amounts are not converted.` })
          break
        }
        case "addParticipant": {
          const result = addParticipant(state.trip, context.name)
          if (!commit(result, "Participant not added", "people") || !result.ok) return
          channel.send(replaceComponents(surfaceId, participantPickers(state.trip)), update(surfaceId, "/newParticipant", ""))
          api.ui.toast({ kind: "success", title: "Participant added", description: result.message })
          break
        }
        case "removeParticipant": {
          const id = typeof context.id === "string" ? context.id : ""
          const precheck = removeParticipant(state.trip, id)
          if (!precheck.ok) {
            showError("people", { title: "Cannot remove", text: precheck.error })
            return
          }
          const confirmed = await api.ui.confirm({ title: `Remove ${participantName(state.trip, id)}?`, description: "They are not part of any expense, so no balance changes.", confirmLabel: "Remove" })
          if (!confirmed || !commit(removeParticipant(state.trip, id), "Participant not removed", "people")) return
          const keep = (value: unknown) => (Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string" && entry !== id) : [])
          channel.send(
            replaceComponents(surfaceId, participantPickers(state.trip)),
            update(surfaceId, "/draft/payer", keep(context.payer)),
            update(surfaceId, "/draft/split", keep(context.split)),
          )
          api.ui.toast({ kind: "info", title: "Participant removed", description: precheck.message })
          break
        }
        case "addExpense": {
          const result = addExpense(state.trip, context.draft)
          if (!commit(result, "Expense not added", "form") || !result.ok) return
          channel.send(update(surfaceId, "/draft", emptyDraft(state.trip, localIsoDate(new Date()))))
          api.ui.toast({ kind: "success", title: "Expense added", description: result.message })
          break
        }
        case "deleteExpense": {
          const id = typeof context.id === "string" ? context.id : ""
          const expense = state.trip.expenses.find((entry) => entry.id === id)
          if (!expense) return
          const confirmed = await api.ui.confirm({
            title: `Delete “${expense.description}”?`,
            description: `${formatMoney(expense.amount, state.trip.currency)} paid by ${participantName(state.trip, expense.payer)} leaves every balance.`,
            confirmLabel: "Delete expense",
          })
          if (!confirmed) return
          const result = deleteExpense(state.trip, id)
          if (!commit(result, "Expense not deleted", "expenses") || !result.ok) return
          api.ui.toast({ kind: "info", title: "Expense deleted", description: result.message })
          break
        }
        case "saveBudgets": {
          const result = setBudgets(state.trip, context.categories)
          if (!commit(result, "Budgets not saved", "budgets") || !result.ok) return
          sendBudgets()
          api.ui.toast({ kind: "success", title: "Budgets saved", description: result.message })
          break
        }
      }
      refresh()
    },
  }
}

export default definePlugin({
  activate(api) {
    const state = { trip: seedTrip(localIsoDate(new Date())) }
    api.pages.register({ id: PAGE_ID, path: "/budget-split", title: "Trip budget", surface: (channel) => openBudget(api, state, channel) })
    api.sidebar.item({ id: PAGE_ID, label: "Trip budget", pageId: PAGE_ID, icon: "split" })
    api.commands.register({ id: "budget-split.open", title: "Open trip budget", category: "Trip budget", run: () => api.pages.open(PAGE_ID) })
    api.commands.register({
      id: "budget-split.settle",
      title: "Who owes whom on the trip",
      category: "Trip budget",
      run: () => {
        api.ui.toast({ kind: "info", title: "Settle up", description: settlementText(state.trip) })
        api.pages.open(PAGE_ID)
      },
    })
  },
})

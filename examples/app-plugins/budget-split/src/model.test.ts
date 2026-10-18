import { describe, expect, test } from "bun:test"
import {
  CATEGORIES,
  addExpense,
  addParticipant,
  balanceStatus,
  balances,
  categoryStatus,
  categoryTotals,
  deleteExpense,
  formatMoney,
  parseAmount,
  removeParticipant,
  seedTrip,
  setBudgets,
  setCurrency,
  settle,
  splitEvenly,
  summaryMarkdown,
  totalSpent,
  type Balance,
  type Trip,
  type TripResult,
} from "./model"

const TODAY = "2026-10-18"

function expectOk(result: TripResult): Trip {
  if (!result.ok) throw new Error(result.error)
  return result.trip
}

function expectRefused(result: TripResult): string {
  if (result.ok) throw new Error(`expected a refusal, got: ${result.message}`)
  return result.error
}

function cents(value: unknown): number | string {
  const parsed = parseAmount(value)
  return parsed.ok ? parsed.cents : parsed.error
}

function applyTransfers(list: readonly Balance[]): Map<string, number> {
  const nets = new Map(list.map((balance) => [balance.id, balance.net]))
  for (const transfer of settle(list)) {
    nets.set(transfer.from, (nets.get(transfer.from) ?? 0) + transfer.amount)
    nets.set(transfer.to, (nets.get(transfer.to) ?? 0) - transfer.amount)
  }
  return nets
}

function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 2 ** 32
  }
}

function randomTrip(seed: number): Trip {
  const random = seededRandom(seed)
  const size = 2 + Math.floor(random() * 9)
  const participants = Array.from({ length: size }, (_, index) => ({ id: `p${index}`, name: `Person ${index}` }))
  const expenses = Array.from({ length: 1 + Math.floor(random() * 25) }, (_, index) => {
    const split = participants.filter(() => random() < 0.6).map((participant) => participant.id)
    return {
      id: `e${index}`,
      description: `Expense ${index}`,
      amount: 1 + Math.floor(random() * 50_000),
      payer: participants[Math.floor(random() * size)]!.id,
      splitAmong: split.length > 0 ? split : [participants[0]!.id],
      category: CATEGORIES[Math.floor(random() * CATEGORIES.length)]!.id,
      date: TODAY,
    }
  })
  return { ...seedTrip(TODAY), participants, expenses }
}

describe("parsing amounts", () => {
  test("reads plain, comma-decimal and thousands-separated input", () => {
    expect(cents("12")).toBe(1200)
    expect(cents("12.5")).toBe(1250)
    expect(cents("12,50")).toBe(1250)
    expect(cents("1,234.56")).toBe(123456)
    expect(cents("1.234,56")).toBe(123456)
    expect(cents("12,345")).toBe(1234500)
    expect(cents(" 7.")).toBe(700)
    expect(cents(42.1)).toBe(4210)
  })

  test("rounds half up to the cent without floating-point drift", () => {
    expect(cents("1.005")).toBe(101)
    expect(cents("1.004")).toBe(100)
    expect(cents("0.995")).toBe(100)
    expect(cents("2.3449")).toBe(234)
    expect(cents(1.005)).toBe(101)
    expect(cents(0.1 + 0.2)).toBe(30)
  })

  test("refuses empty, negative, zero, malformed and huge amounts", () => {
    expect(cents("")).toBe("Enter an amount.")
    expect(cents("-5")).toBe("The amount must be positive.")
    expect(cents("0.004")).toBe("The amount must be at least one cent.")
    expect(cents("12.3.4")).toMatch(/is not an amount/)
    expect(cents("1,2,3")).toMatch(/is not an amount/)
    expect(cents("abc")).toMatch(/is not an amount/)
    expect(cents("20000000")).toBe("That amount is too large for one expense.")
    expect(cents(Number.NaN)).toBe("Enter an amount.")
  })
})

describe("splitting", () => {
  test("shares always sum to the amount, leftover cents going to the first people", () => {
    expect([...splitEvenly(1000, ["a", "b", "c"]).values()]).toEqual([334, 333, 333])
    expect([...splitEvenly(2, ["a", "b", "c"]).values()]).toEqual([1, 1, 0])
    expect([...splitEvenly(900, ["a", "b", "c"]).values()]).toEqual([300, 300, 300])
    expect(splitEvenly(500, []).size).toBe(0)
    for (let amount = 1; amount < 400; amount += 7) {
      for (let people = 1; people <= 9; people += 1) {
        const shares = [...splitEvenly(amount, Array.from({ length: people }, (_, index) => `p${index}`)).values()]
        expect(shares.reduce((sum, share) => sum + share, 0)).toBe(amount)
        expect(Math.max(...shares) - Math.min(...shares)).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe("balances", () => {
  test("seed trip: paid, share and net per person to the cent", () => {
    expect(balances(seedTrip(TODAY))).toEqual([
      { id: "p1", name: "Ana", paid: 74000, share: 27886, net: 46114 },
      { id: "p2", name: "Ben", paid: 20560, share: 28885, net: -8325 },
      { id: "p3", name: "Chloé", paid: 18983, share: 33254, net: -14271 },
      { id: "p4", name: "Dev", paid: 5365, share: 28883, net: -23518 },
    ])
    expect(totalSpent(seedTrip(TODAY))).toBe(118908)
  })

  test("sum to exactly zero for many random trips", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const trip = randomTrip(seed)
      const list = balances(trip)
      expect(list.reduce((sum, balance) => sum + balance.net, 0)).toBe(0)
      expect(list.reduce((sum, balance) => sum + balance.share, 0)).toBe(totalSpent(trip))
    }
  })
})

describe("balance status", () => {
  test("says who is owed, who owes and who is settled", () => {
    const status = (net: number) => balanceStatus({ id: "p1", name: "Ana", paid: 0, share: 0, net }, "EUR")
    expect(status(1234)).toEqual({ label: "is owed €12.34", tone: "success" })
    expect(status(-500)).toEqual({ label: "owes €5.00", tone: "warning" })
    expect(status(0)).toEqual({ label: "settled up", tone: "neutral" })
  })
})

describe("settlement", () => {
  test("seed trip: everyone pays Ana, largest debt first", () => {
    expect(settle(balances(seedTrip(TODAY)))).toEqual([
      { from: "p4", to: "p1", amount: 23518 },
      { from: "p3", to: "p1", amount: 14271 },
      { from: "p2", to: "p1", amount: 8325 },
    ])
  })

  test("pairs an exact match in one transfer and breaks ties by participant order", () => {
    const list: Balance[] = [
      { id: "a", name: "A", paid: 0, share: 0, net: 500 },
      { id: "b", name: "B", paid: 0, share: 0, net: 500 },
      { id: "c", name: "C", paid: 0, share: 0, net: -500 },
      { id: "d", name: "D", paid: 0, share: 0, net: -500 },
    ]
    expect(settle(list)).toEqual([
      { from: "c", to: "a", amount: 500 },
      { from: "d", to: "b", amount: 500 },
    ])
  })

  test("needs no transfers when everyone is square", () => {
    expect(settle([{ id: "a", name: "A", paid: 100, share: 100, net: 0 }])).toEqual([])
  })

  test("zeroes every balance with at most n−1 positive transfers, never paying and receiving", () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const list = balances(randomTrip(seed))
      const transfers = settle(list)
      for (const net of applyTransfers(list).values()) expect(net).toBe(0)
      expect(transfers.length).toBeLessThanOrEqual(Math.max(0, list.length - 1))
      for (const transfer of transfers) {
        expect(transfer.amount).toBeGreaterThan(0)
        expect(Number.isInteger(transfer.amount)).toBe(true)
      }
      const payers = new Set(transfers.map((transfer) => transfer.from))
      for (const transfer of transfers) expect(payers.has(transfer.to)).toBe(false)
    }
  })
})

describe("participants", () => {
  test("adds a trimmed unique name with the next id", () => {
    const trip = expectOk(addParticipant(seedTrip(TODAY), "  Eva   Marie "))
    expect(trip.participants.at(-1)).toEqual({ id: "p20", name: "Eva Marie" })
    expect(trip.nextId).toBe(21)
  })

  test("refuses blanks, duplicates in any case, long names and a full trip", () => {
    const seed = seedTrip(TODAY)
    expectRefused(addParticipant(seed, "   "))
    expect(expectRefused(addParticipant(seed, "chloé"))).toBe("chloé is already on the trip.")
    expectRefused(addParticipant(seed, "x".repeat(41)))
    let trip = seed
    for (let index = 0; index < 8; index += 1) trip = expectOk(addParticipant(trip, `Guest ${index}`))
    expect(expectRefused(addParticipant(trip, "One too many"))).toBe("A trip holds at most 12 people.")
  })

  test("refuses to remove someone who is part of an expense", () => {
    expect(expectRefused(removeParticipant(seedTrip(TODAY), "p3"))).toBe("Chloé is part of 7 expenses. Delete or re-enter those first so the balances stay correct.")
    const withEva = expectOk(addParticipant(seedTrip(TODAY), "Eva"))
    expect(expectOk(removeParticipant(withEva, "p20")).participants).toHaveLength(4)
    expectRefused(removeParticipant(withEva, "nobody"))
  })
})

describe("expenses", () => {
  const draft = { description: "Ferry to Cacilhas", amount: "10", payer: ["p2"], split: ["p3", "p1", "ghost"], category: ["transport"], date: TODAY }

  test("adds an expense with split order following the participant list", () => {
    const result = addExpense(seedTrip(TODAY), draft)
    const trip = expectOk(result)
    expect(trip.expenses.at(-1)).toEqual({ id: "e20", description: "Ferry to Cacilhas", amount: 1000, payer: "p2", splitAmong: ["p1", "p3"], category: "transport", date: TODAY })
    expect(result.ok && result.message).toBe("Ben paid €10.00 for Ferry to Cacilhas, split 2 ways.")
    expect(balances(trip).reduce((sum, balance) => sum + balance.net, 0)).toBe(0)
  })

  test("refuses each invalid field with a specific reason", () => {
    const seed = seedTrip(TODAY)
    expect(expectRefused(addExpense(seed, { ...draft, description: " " }))).toBe("Describe the expense.")
    expect(expectRefused(addExpense(seed, { ...draft, amount: "-3" }))).toBe("The amount must be positive.")
    expect(expectRefused(addExpense(seed, { ...draft, payer: ["ghost"] }))).toBe("Choose who paid.")
    expect(expectRefused(addExpense(seed, { ...draft, split: ["ghost"] }))).toBe("Choose at least one person to split with.")
    expect(expectRefused(addExpense(seed, { ...draft, category: ["souvenirs"] }))).toBe("Choose a category.")
    expect(expectRefused(addExpense(seed, { ...draft, date: "2026-02-31" }))).toBe("Choose the date of the expense.")
    expect(expectRefused(addExpense(seed, null))).toBe("Describe the expense.")
  })

  test("deleting an expense removes it from every total", () => {
    const trip = expectOk(deleteExpense(seedTrip(TODAY), "e1"))
    expect(totalSpent(trip)).toBe(118908 - 64000)
    expect(balances(trip)[0]?.paid).toBe(10000)
    expectRefused(deleteExpense(trip, "e1"))
  })
})

describe("budgets and categories", () => {
  test("totals each category against its budget", () => {
    expect(categoryTotals(seedTrip(TODAY)).map((row) => [row.id, row.spent, row.budget, row.percent, row.over])).toEqual([
      ["lodging", 64000, 70000, 91, false],
      ["food", 20873, 25000, 83, false],
      ["transport", 6035, 8000, 75, false],
      ["activities", 28000, 30000, 93, false],
      ["other", 0, 5000, 0, false],
    ])
  })

  test("saves slider budgets in major units, clamped to the currency's range", () => {
    const trip = expectOk(setBudgets(seedTrip(TODAY), [{ id: "food", budget: 150 }, { id: "transport", budget: 99999 }, { id: "other", budget: -4 }, { id: "nope", budget: 5 }, { id: "lodging", budget: "x" }]))
    expect(trip.budgets).toEqual({ lodging: 70000, food: 15000, transport: 500000, activities: 30000, other: 0 })
    const food = categoryTotals(trip).find((row) => row.id === "food")
    expect(food?.over).toBe(true)
    expect(food?.percent).toBe(139)
    expectRefused(setBudgets(trip, "nope"))
  })

  test("a blank budget field keeps the saved budget", () => {
    const trip = expectOk(setBudgets(seedTrip(TODAY), [{ id: "food", budget: " " }, { id: "other", budget: "75.5" }]))
    expect(trip.budgets.food).toBe(25000)
    expect(trip.budgets.other).toBe(7550)
  })

  test("a category reads as left, nearly used up or over, in words and a tone", () => {
    const rows = categoryTotals(seedTrip(TODAY))
    expect(rows.map((row) => categoryStatus(row, "EUR"))).toEqual([
      { label: "€60.00 left", tone: "warning" },
      { label: "€41.27 left", tone: "neutral" },
      { label: "€19.65 left", tone: "neutral" },
      { label: "€20.00 left", tone: "warning" },
      { label: "€50.00 left", tone: "neutral" },
    ])
    const over = categoryTotals(expectOk(setBudgets(seedTrip(TODAY), [{ id: "food", budget: 150 }]))).find((row) => row.id === "food")!
    expect(categoryStatus(over, "EUR")).toEqual({ label: "€58.73 over", tone: "danger" })
  })

  test("a zero budget with spending reads as fully used", () => {
    const trip = expectOk(setBudgets(seedTrip(TODAY), [{ id: "food", budget: 0 }]))
    expect(categoryTotals(trip).find((row) => row.id === "food")?.percent).toBe(100)
  })
})

describe("currency", () => {
  test("formats each currency in its own convention", () => {
    expect(formatMoney(123456, "EUR")).toBe("€1,234.56")
    expect(formatMoney(123456, "USD")).toBe("$1,234.56")
    expect(formatMoney(12345678, "INR")).toBe("₹1,23,456.78")
    expect(formatMoney(-2500, "EUR")).toBe("-€25.00")
  })

  test("switches only to a supported currency", () => {
    expect(expectOk(setCurrency(seedTrip(TODAY), ["INR"])).currency).toBe("INR")
    expectRefused(setCurrency(seedTrip(TODAY), ["GBP"]))
  })
})

describe("export", () => {
  test("summarizes categories, balances and transfers as Markdown", () => {
    const markdown = summaryMarkdown(seedTrip(TODAY))
    expect(markdown).toContain("# Lisbon, long weekend")
    expect(markdown).toContain("4 people · 8 expenses · €1,189.08 total · €297.27 per person on average")
    expect(markdown).toContain("| Food & drink | €208.73 | €250.00 | 83% |")
    expect(markdown).toContain("| Ana | €740.00 | €278.86 | +€461.14 |")
    expect(markdown).toContain("- Dev pays Ana €235.18")
  })

  test("says everyone is square when nothing is owed", () => {
    expect(summaryMarkdown({ ...seedTrip(TODAY), expenses: [] })).toContain("Everyone is square.")
  })
})

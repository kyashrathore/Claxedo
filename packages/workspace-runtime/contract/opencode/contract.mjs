/**
 * Executable contract probe for the pinned public OpenCode embedded SDK.
 *
 * Each check is tagged with the property of the SDK it asserts. A failure
 * means the pinned release drifted; move the pin, do not compensate in Claxedo.
 *
 * Shared by both entrypoints so there is one set of assertions:
 *   probe.mjs      - imports the published package directly (needs Bun)
 *   probe-node.mjs - imports the Node bundle produced by build-node-bundle.ts
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export async function runContract(OpenCode) {
  const results = []
  function check(section, name, actual, expected) {
    const ok = JSON.stringify(actual) === JSON.stringify(expected)
    results.push({ ok, section, name, actual, expected })
    console.log(`${ok ? "PASS" : "FAIL"}  [${section}]  ${name}`)
    if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`)
  }
  function record(section, name, value) {
    results.push({ ok: true, section, name, actual: value, informational: true })
    console.log(`INFO  [${section}]  ${name} = ${JSON.stringify(value)}`)
  }
  async function checkResolves(section, name, run) {
    try {
      await run()
      check(section, name, true, true)
    } catch (error) {
      check(section, name, error?.cause?.status ?? error?.name ?? String(error), true)
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-contract-"))
  const dbPath = path.join(root, "opencode.db")
  const wsA = path.join(root, "ws-a")
  const wsB = path.join(root, "ws-b")
  fs.mkdirSync(wsA)
  fs.mkdirSync(wsB)

  const bootStart = Date.now()
  const oc = await OpenCode.create({ database: { path: dbPath }, events: { persist: true } })
  record("lifecycle", "cold boot ms", Date.now() - bootStart)
  check("lifecycle", "explicit database.path is honored", fs.existsSync(dbPath), true)
  check("lifecycle", "close() is present", typeof oc.close, "function")
  check("lifecycle", "asyncDispose is present", typeof oc[Symbol.asyncDispose], "function")
  check("lifecycle", "public interface exposes NO raw fetch", typeof oc.fetch, "undefined")

  // Recorded, not asserted: this status flag is not a readiness signal.
  record("migration", "migration.v1.status on a fresh db", await oc.migration.v1.status())

  check("api", "credential group has no list()", Object.keys(oc.credential).sort(), ["activate", "remove", "update"])
  check("api", "session group has no archive()", typeof oc.sessions.archive, "undefined")
  check("api", "mcp has no atomic update()", typeof oc.mcp.update, "undefined")
  check("api", "mcp has no atomic restart()", typeof oc.mcp.restart, "undefined")
  check("api", "pty IS supported (retired by choice, not absence)", typeof oc.pty.create, "function")
  check("api", "no todo API", typeof oc.todo, "undefined")
  check("api", "forms exist", typeof oc.form.reply, "function")

  const seen = []
  const ac = new AbortController()
  const pump = (async () => {
    try {
      for await (const event of oc.events.subscribe({ signal: ac.signal })) seen.push(event)
    } catch {
      /* aborted */
    }
  })()

  const a = await oc.sessions.create({ location: { directory: wsA }, title: "contract-a" })
  const b = await oc.sessions.create({ location: { directory: wsB }, title: "contract-b" })
  await new Promise((resolve) => setTimeout(resolve, 500))

  const ids = (page) => (page.data ?? []).map((row) => row.id)
  const listA = ids(await oc.sessions.list({ directory: wsA }))
  const listB = ids(await oc.sessions.list({ directory: wsB }))
  const listAll = ids(await oc.sessions.list({}))

  check("isolation", "directory-scoped list isolates wsA", [listA.includes(a.id), listA.includes(b.id)], [true, false])
  check("isolation", "directory-scoped list isolates wsB", [listB.includes(b.id), listB.includes(a.id)], [true, false])
  // An unscoped list is host-global; the typed port must never expose one.
  check("isolation", "unscoped list is host-global", listAll.length >= 2, true)

  // Claxedo's workspace scope is the only barrier to a cross-workspace read.
  const crossRead = await oc.sessions.get({ sessionID: b.id })
  check("isolation", "sessions.get performs NO location authorization", crossRead.location.directory, wsB)

  // A nested `location` filter is silently ignored by list() — it is not part of
  // SessionListInput. This mistake returns the host-global set and looks like a
  // successful scoped query. The typed port must make it unrepresentable.
  const bogus = ids(await oc.sessions.list({ location: { directory: wsA } }))
  check("isolation", "nested location filter is silently ignored by list()", bogus.length >= 2, true)

  const exported = await oc.sessions.export({ sessionID: a.id })
  check("transfer", "export envelope matches SessionTransferData", Object.keys(exported).sort(), ["info", "messages"])
  check("transfer", "export preserves session identity", exported.info.id, a.id)
  // The legacy fork's CLI exporter writes the same envelope; session transfer relies on it.

  ac.abort()
  await pump
  const byType = new Map(seen.map((event) => [event.type, event]))
  record("events", "event types observed", [...byType.keys()])
  const created = byType.get("session.created")
  const connected = byType.get("server.connected")
  if (created) {
    check("events", "session.created carries a durable aggregate sequence", typeof created.durable?.seq, "number")
    check("events", "session.created carries a location", typeof created.location?.directory, "string")
  }
  if (connected) {
    // No durable sequence => cannot be checkpointed or replayed after reconnect.
    check("events", "server.connected has NO durable sequence", connected.durable, undefined)
    check("events", "every event still carries an id", typeof connected.id, "string")
  }

  // A broken core build once 500'd every location-resolving call; these stay
  // public-API calls, never a reach into core. Run after event teardown so the
  // durability probe is independent of catalog init.
  await checkResolves("location", "config.get resolves a location", () => oc.config.get({ location: { directory: wsA } }))
  await checkResolves("location", "agent.list resolves a location", () => oc.agent.list({ location: { directory: wsA } }))
  await checkResolves("location", "provider.list resolves a location", () =>
    oc.provider.list({ location: { directory: wsA } }),
  )

  const sessionSnapshot = await oc.sessions.get({ sessionID: a.id })
  check("events", "session snapshot carries token totals", typeof sessionSnapshot.tokens, "object")
  check("events", "session snapshot carries cost", typeof sessionSnapshot.cost, "number")

  await oc.close()
  const restarted = await OpenCode.create({ database: { path: dbPath } })
  const afterRestart = await restarted.sessions.get({ sessionID: a.id })
  check("lifecycle", "session survives host close/reopen on same db", afterRestart.id, a.id)
  await restarted.close()

  fs.rmSync(root, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  if (failed.length) {
    console.log("\nA failure means the pinned SDK drifted from the contract doc.")
    console.log("Move the pin to a later exact beta - do not compensate in Claxedo code.")
  }
  return failed.length
}

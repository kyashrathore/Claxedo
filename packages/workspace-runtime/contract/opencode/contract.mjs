/**
 * Executable contract probe for the pinned public OpenCode embedded SDK.
 *
 * Every assertion here corresponds to a numbered claim in
 * `docs/architecture/opencode-embedded-sdk-contract.md`. A failure means the
 * pinned release no longer behaves the way the cutover plan assumes, which is a
 * stop-and-re-plan signal — not something to work around in Claxedo code.
 *
 * Shared by both entrypoints so there is exactly one set of assertions:
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
    console.log(`${ok ? "PASS" : "FAIL"}  §${section}  ${name}`)
    if (!ok) console.log(`      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`)
  }
  function record(section, name, value) {
    results.push({ ok: true, section, name, actual: value, informational: true })
    console.log(`INFO  §${section}  ${name} = ${JSON.stringify(value)}`)
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

  // --- §3 Host lifecycle -----------------------------------------------------
  const bootStart = Date.now()
  const oc = await OpenCode.create({ database: { path: dbPath }, events: { persist: true } })
  record(3, "cold boot ms", Date.now() - bootStart)
  check(3, "explicit database.path is honored", fs.existsSync(dbPath), true)
  check(3, "close() is present", typeof oc.close, "function")
  check(3, "asyncDispose is present", typeof oc[Symbol.asyncDispose], "function")
  // Decision 4: the public interface must never hand a consumer a raw transport.
  check(3, "public interface exposes NO raw fetch", typeof oc.fetch, "undefined")

  // --- §6.2 Node V1 migration is a no-op ------------------------------------
  // Diagnostic only. Readiness must come from semantic validation (Unit 6).
  record(6.2, "migration.v1.status on a fresh db", await oc.migration.v1.status())

  // --- §7 API surface parity -------------------------------------------------
  check(7, "credential group has no list()", Object.keys(oc.credential).sort(), ["activate", "remove", "update"])
  check(7, "session group has no archive()", typeof oc.sessions.archive, "undefined")
  check(7, "mcp has no atomic update()", typeof oc.mcp.update, "undefined")
  check(7, "mcp has no atomic restart()", typeof oc.mcp.restart, "undefined")
  check(7, "pty IS supported (retired by choice, not absence)", typeof oc.pty.create, "function")
  check(7, "no todo API", typeof oc.todo, "undefined")
  check(7, "forms exist", typeof oc.form.reply, "function")

  // --- §5 Event durability ---------------------------------------------------
  const seen = []
  const ac = new AbortController()
  const pump = (async () => {
    try {
      for await (const event of oc.events.subscribe({ signal: ac.signal })) seen.push(event)
    } catch {
      /* aborted */
    }
  })()

  // --- §4 Workspace isolation ------------------------------------------------
  const a = await oc.sessions.create({ location: { directory: wsA }, title: "contract-a" })
  const b = await oc.sessions.create({ location: { directory: wsB }, title: "contract-b" })
  await new Promise((resolve) => setTimeout(resolve, 500))

  const ids = (page) => (page.data ?? []).map((row) => row.id)
  const listA = ids(await oc.sessions.list({ directory: wsA }))
  const listB = ids(await oc.sessions.list({ directory: wsB }))
  const listAll = ids(await oc.sessions.list({}))

  // Decision 3 survives: directory-scoped listing really is isolated.
  check(4, "directory-scoped list isolates wsA", [listA.includes(a.id), listA.includes(b.id)], [true, false])
  check(4, "directory-scoped list isolates wsB", [listB.includes(b.id), listB.includes(a.id)], [true, false])
  // ...but an unscoped list is host-global. The typed port must never expose one.
  check(4, "unscoped list is host-global", listAll.length >= 2, true)

  // Decision 13 is load-bearing: the SDK authorizes nothing by location.
  // Claxedo's workspace scope is the ONLY barrier to a cross-workspace read.
  const crossRead = await oc.sessions.get({ sessionID: b.id })
  check(4, "sessions.get performs NO location authorization", crossRead.location.directory, wsB)

  // A nested `location` filter is silently ignored by list() — it is not part of
  // SessionListInput. This mistake returns the host-global set and looks like a
  // successful scoped query. The typed port must make it unrepresentable.
  const bogus = ids(await oc.sessions.list({ location: { directory: wsA } }))
  check(4, "nested location filter is silently ignored by list()", bogus.length >= 2, true)

  // --- §6 Session transfer ---------------------------------------------------
  const exported = await oc.sessions.export({ sessionID: a.id })
  check(6, "export envelope matches SessionTransferData", Object.keys(exported).sort(), ["info", "messages"])
  check(6, "export preserves session identity", exported.info.id, a.id)
  // The legacy fork's CLI exporter writes the same `{ info, messages }` envelope,
  // which is what makes the checkpoint 6a -> 6b transfer viable at all.

  // --- §5 Event durability assertions ---------------------------------------
  ac.abort()
  await pump
  const byType = new Map(seen.map((event) => [event.type, event]))
  record(5, "event types observed", [...byType.keys()])
  const created = byType.get("session.created")
  const connected = byType.get("server.connected")
  if (created) {
    check(5, "session.created carries a durable aggregate sequence", typeof created.durable?.seq, "number")
    check(5, "session.created carries a location", typeof created.location?.directory, "string")
  }
  if (connected) {
    // No durable sequence => cannot be checkpointed or replayed after reconnect.
    check(5, "server.connected has NO durable sequence", connected.durable, undefined)
    check(5, "every event still carries an id", typeof connected.id, "string")
  }

  // --- §2.3 Upstream layer-graph regression ---------------------------------
  // beta-18314 captured an undefined FileSystemSearch dependency at build
  // time, making every location-resolving call return an empty 500. Keep the
  // public calls as the permanent contract instead of reaching into core.
  // Resolve the catalogs after event teardown so the durability probe keeps
  // exercising the same subscription lifecycle independently of catalog init.
  await checkResolves(2.3, "config.get resolves a location", () => oc.config.get({ location: { directory: wsA } }))
  await checkResolves(2.3, "agent.list resolves a location", () => oc.agent.list({ location: { directory: wsA } }))
  await checkResolves(2.3, "provider.list resolves a location", () =>
    oc.provider.list({ location: { directory: wsA } }),
  )

  // --- §5 Usage is snapshot-derived ------------------------------------------
  const sessionSnapshot = await oc.sessions.get({ sessionID: a.id })
  check(5, "session snapshot carries token totals", typeof sessionSnapshot.tokens, "object")
  check(5, "session snapshot carries cost", typeof sessionSnapshot.cost, "number")

  // --- §3 Persistence across host restart ------------------------------------
  await oc.close()
  const restarted = await OpenCode.create({ database: { path: dbPath } })
  const afterRestart = await restarted.sessions.get({ sessionID: a.id })
  check(3, "session survives host close/reopen on same db", afterRestart.id, a.id)
  await restarted.close()

  fs.rmSync(root, { recursive: true, force: true })

  const failed = results.filter((r) => !r.ok)
  console.log(`\n${results.length - failed.length} passed, ${failed.length} failed`)
  if (failed.length) {
    console.log("\nA failure means the pinned SDK drifted from the cutover contract.")
    console.log("Stop and re-plan against a later exact beta - do not compensate in Claxedo code.")
  }
  return failed.length
}

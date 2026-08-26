/**
 * Minimal, self-contained reproduction for the upstream report.
 *
 * Everything here uses only documented public API: `OpenCode.create()` and the
 * typed client. No deep imports, no internal host, no overrides.
 *
 *   node repro-upstream.mjs      (after: bun run build-node-bundle.ts)
 *   bun run repro-upstream.mjs   (works directly, no bundle needed)
 */
const { OpenCode } = await import("./dist-node/sdk-entry.js").catch(() => import("@opencode-ai/sdk"))
const fs = await import("node:fs")
const os = await import("node:os")
const path = await import("node:path")

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-repro-"))
const workspace = path.join(root, "workspace")
fs.mkdirSync(workspace)
fs.writeFileSync(path.join(workspace, "README.md"), "# repro\n")

const oc = await OpenCode.create({ database: { path: path.join(root, "opencode.db") } })

async function show(label, run) {
  try {
    const value = await run()
    const rows = value?.data ?? value
    console.log(`  OK   ${label}`, Array.isArray(rows) ? `count=${rows.length}` : JSON.stringify(rows).slice(0, 90))
  } catch (error) {
    console.log(`  FAIL ${label}`, `${error?.reason ?? error?._tag ?? "error"} ${JSON.stringify(error?.cause ?? {})}`)
  }
}

console.log("what works:")
await show("health.get       ", () => oc.health.get())
await show("sessions.create  ", () => oc.sessions.create({ location: { directory: workspace }, title: "repro" }))
const session = await oc.sessions.list({ directory: workspace }).then((page) => page.data[0])

console.log("\nwhat does not — every call that resolves a location:")
await show("location.get     ", () => oc.location.get({ directory: workspace }))
await show("project.list     ", () => oc.project.list())
await show("config.get       ", () => oc.config.get({ location: { directory: workspace } }))
await show("provider.list    ", () => oc.provider.list({ location: { directory: workspace } }))
await show("agent.list       ", () => oc.agent.list({ location: { directory: workspace } }))

console.log("\nand execution, even with an explicit model:")
await show("sessions.prompt  ", () =>
  oc.sessions.prompt({
    sessionID: session.id,
    model: { providerID: "anthropic", id: "claude-opus-4-7" },
    parts: [{ type: "text", text: "hello" }],
  }),
)

console.log("\ncontext:")
await show("workspace.create ", () => oc.workspace.create({ provider: "local" }))
await show("debug.location.list", () => oc.debug.location.list())

await oc.close()
fs.rmSync(root, { recursive: true, force: true })

console.log(`
Suspected cause, from the published source:
  @opencode-ai/core defines the default workspace driver as \`node = registryNode({})\`
  — an EMPTY provider registry. \`workspace.create\` needs a provider that exists in
  it, and the public \`CreateOptions\` is \`Omit<EmbeddedHost.CreateOptions, "workspaceProviders">\`,
  so nothing can register one. No location provisions, and every call that
  resolves a location fails.`)

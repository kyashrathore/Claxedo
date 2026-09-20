import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import { promisify } from "node:util"
import { deriveRelayHostKid, mintRelayHostToken, mintRuntimeAccessToken, workspaceRelayForwardHeaders } from "@claxedo/workspace-relay"
import { importJWK } from "jose"
import { loopbackReplayHeaders } from "@claxedo/server-core/platform/http/peer-address"
import { hostServingSurface } from "../../claxedo-host-serving/src/surface.ts"
import { createMachineSignedTransport } from "../../claxedo-host-connector/src/machine-transport.ts"
import { hostKeyPairFromJwk } from "../../claxedo-host-connector/src/host-identity.ts"
import { createFakeServiceManager, writeManagerShims } from "../../cli/src/connect/machine-simulator.test-support.ts"

// The `claxedo connect` half of `signed-browser-relay-fixture.mjs`: the
// machine-side process lifecycle a spec drives through `/__fixture/connect/*`,
// the fault barriers, and the token mints a spec probes the relay and the
// host runtime with. The owner routes `claxedo host …` targets and the relay
// resolver the relay child asks are the self-host composition's own; nothing
// here reaches the authority except through its port.

const execFileAsync = promisify(execFile)

export const CLI_ENTRY = path.resolve(process.cwd(), "..", "cli", "src", "index.ts")

/**
 * The same loader recipe `web-signed-relay-harness.ts` spawns this fixture
 * with, so the CLI runs its SOURCE with every workspace package resolved
 * source-first — a stale `packages/cli/dist` cannot answer for it.
 */
export function cliCommand(args) {
  return ["node", ["--conditions=development", "--import", "./src/text-imports.mjs", "--import", "tsx", CLI_ENTRY, ...args]]
}

/**
 * The same recipe as `NODE_OPTIONS`, for a process a service manager starts
 * from the unit `--install-service` wrote: that ExecStart is the bare
 * `node <index.ts> connect --foreground` the installing process was, so the
 * loaders travel in the manager's environment. Absolute, because the manager
 * runs the unit from its own working directory.
 */
const SERVICE_NODE_OPTIONS = `--conditions=development --import ${path.resolve(process.cwd(), "src", "text-imports.mjs")} --import tsx`

async function git(cwd, ...args) {
  await execFileAsync("git", ["-c", "user.email=fixture@example.test", "-c", "user.name=Connect Fixture", ...args], { cwd })
}

/**
 * Three real folders under one root, each a git repository with one committed
 * file: `srv/api`, `srv/web` and `srv/docs`. Paths are `realpath`ed because the host
 * validates a resolved directory against resolved roots, and macOS's tmp dir
 * is a symlink — an invitation naming the unresolved spelling would be
 * refused on the box for a reason nothing in the spec asked about.
 */
export async function provisionConnectRoots(root) {
  const srv = path.join(root, "srv")
  const directories = { api: path.join(srv, "api"), web: path.join(srv, "web"), docs: path.join(srv, "docs") }
  for (const [name, directory] of Object.entries(directories)) {
    await fs.mkdir(directory, { recursive: true })
    await git(directory, "init", "-b", "main")
    await fs.writeFile(path.join(directory, "hello.txt"), `hello from ${name} through claxedo connect\n`)
    await git(directory, "add", "hello.txt")
    await git(directory, "commit", "-m", "initial")
  }
  return {
    root: await fs.realpath(srv),
    api: await fs.realpath(directories.api),
    web: await fs.realpath(directories.web),
    docs: await fs.realpath(directories.docs),
  }
}

/**
 * The two faults a spec throws at the control plane, both independent of the
 * relay and of the host tunnel.
 *
 * `redeemResponseDrop`: the redeem runs to completion — the invitation is
 * consumed and the enrollment row exists — and the response is then held
 * until the barrier is lowered or the caller's socket goes away. This is the
 * "redeem committed, answer lost" recovery case.
 *
 * `controlPlaneOutage`: every machine-facing route (enrollment beats,
 * acquire, redeem) and the runtime's session authority answer 503. Owner
 * routes and the browser's routes keep answering, which is what lets the
 * spec observe the host from the outside during the outage. The relay's
 * resolver routes stay up unless `resolverOutage` is also set, which is the
 * whole control plane gone from the relay's point of view.
 */
export function createFaults() {
  const held = new Set()
  const state = { redeemResponseDrop: false, controlPlaneOutage: false, resolverOutage: false, heldRedeems: 0 }
  return {
    state,
    outage(url) {
      if (!state.controlPlaneOutage) return undefined
      const gated = url.pathname.startsWith("/api/claxedo/host/enrollments")
        || url.pathname.startsWith("/api/runtime-authority")
        || (state.resolverOutage && url.pathname.startsWith("/internal/relay/"))
      if (!gated) return undefined
      return Response.json({ error: { code: "control_plane_outage", message: "Fixture control-plane outage" } }, { status: 503 })
    },
    async holdRedeem(url, response) {
      if (!state.redeemResponseDrop || !url.pathname.endsWith("/redeem")) return response
      state.heldRedeems += 1
      await new Promise((resolve) => held.add(resolve))
      return response
    },
    setRedeemResponseDrop(on) {
      state.redeemResponseDrop = on
      if (on) return
      for (const release of held) release()
      held.clear()
    },
    setControlPlaneOutage(on, resolver = false) {
      state.controlPlaneOutage = on
      state.resolverOutage = on && resolver
    },
  }
}

function tail(text, max = 16_000) {
  return text.length > max ? text.slice(-max) : text
}

/**
 * The `claxedo connect` processes this fixture owns, by name. Each has its
 * own `CLAXEDO_HOME` (the state file, the per-workspace storage root) and
 * its own data dir, so nothing a host writes lands in the control plane's
 * store; `cloneState` copies one home into another, which is the cloned-disk
 * case. Stdout and stderr are kept per instance and returned by `status`.
 */
export function createConnectInstances(input) {
  const instances = new Map()
  let shimDir

  async function homeFor(id, cloneOf) {
    const existing = instances.get(id)
    if (existing?.home) return existing.home
    const home = path.join(input.homesRoot, id)
    if (cloneOf) {
      const source = instances.get(cloneOf)
      if (!source) throw new Error(`no connect instance ${cloneOf} to clone`)
      await fs.cp(source.home, home, { recursive: true })
    } else {
      await fs.mkdir(home, { recursive: true })
    }
    return home
  }

  function running(child) {
    return !!child && child.exitCode === null && !child.signalCode
  }

  function childEnv(home) {
    return {
      ...process.env,
      CLAXEDO_HOME: home,
      CLAXEDO_DATA_DIR: path.join(home, "data"),
      CLAXEDO_CONTROL_PLANE_URL: input.controlPlaneUrl,
      // A host has no account credential; the fixture process may carry one.
      CLAXEDO_DEV_TOKEN: "",
      CLAXEDO_ACCESS_TOKEN: "",
    }
  }

  /** The instance's main process from now on: its output is the instance log, its exit the instance exit. */
  function attach(instance, child) {
    instance.child = child
    instance.log = ""
    instance.exit = undefined
    instance.startedAt = Date.now()
    instance.exited = new Promise((resolve) => {
      child.once("exit", (code, signal) => {
        if (instance.child !== child) return
        instance.exit = { code, signal, at: Date.now() }
        resolve(instance.exit)
      })
    })
    child.stdout.on("data", (chunk) => {
      if (instance.child === child) instance.log += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      if (instance.child === child) instance.log += chunk.toString()
    })
  }

  /**
   * The box `--install-service` runs on: this platform's service manager,
   * with the shims on the installing process's PATH forwarding to it, and the
   * same environment for the unit's process that the fixture gives every
   * connect child. Lingering is on and a runtime dir is set, the state the
   * EC2 proof provisioned.
   */
  async function machineFor(instance, id) {
    if (instance.machine) return instance.machine
    shimDir ??= await writeManagerShims(path.join(input.homesRoot, "manager-bin"))
    const home = instance.home
    const env = {
      ...childEnv(home),
      HOME: home,
      XDG_RUNTIME_DIR: path.join(home, "run"),
      PATH: `${shimDir}${path.delimiter}${process.env.PATH ?? ""}`,
      CLAXEDO_FAKE_MANAGER_URL: `${input.controlPlaneUrl}/__fixture/machine/exec`,
      CLAXEDO_FAKE_MANAGER_INSTANCE: id,
    }
    const manager = createFakeServiceManager(process.platform, {
      home,
      username: os.userInfo().username,
      uid: process.getuid?.() ?? 501,
      linger: true,
      runtimeDir: env.XDG_RUNTIME_DIR,
      cwd: process.cwd(),
      environment: { ...env, NODE_OPTIONS: SERVICE_NODE_OPTIONS },
      onChild: (child) => attach(instance, child),
      log: (line) => console.error(`[machine ${id}] ${line}`),
    })
    instance.machine = { manager, env }
    return instance.machine
  }

  return {
    async start(options) {
      const current = instances.get(options.id)
      if (running(current?.child)) throw new Error(`connect instance ${options.id} is already running`)
      const home = await homeFor(options.id, options.cloneOf)
      const instance = current ?? { id: options.id, home, child: undefined, log: "", exit: undefined }
      instances.set(options.id, instance)
      // The developer's own desktop daemon may be live on this box; the fixture's host is a second machine beside it by design.
      const args = ["connect", options.service === "fake-systemd" ? "--install-service" : "--foreground", "--alongside-desktop"]
      const tokenFile = path.join(home, "invitation.token")
      if (options.token) {
        await fs.writeFile(tokenFile, `${options.token}\n`, { mode: 0o600 })
        args.push("--token-file", tokenFile)
      }
      for (const root of options.roots ?? []) args.push("--root", root)
      if (options.name) args.push("--name", options.name)
      const [command, commandArgs] = cliCommand(args)
      const env = options.service === "fake-systemd" ? (await machineFor(instance, options.id)).env : childEnv(home)
      const child = spawn(command, commandArgs, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] })
      const started = { id: options.id, pid: child.pid, home, stateFile: path.join(home, "connect", "state.json"), tokenFile }
      if (options.service !== "fake-systemd") {
        attach(instance, child)
        return started
      }
      // The installer is not the instance's process: it writes the unit,
      // asks the manager to start it — which attaches the unit's process —
      // and exits. Its own output and exit come back to the caller.
      let log = ""
      child.stdout.on("data", (chunk) => (log += chunk.toString()))
      child.stderr.on("data", (chunk) => (log += chunk.toString()))
      const exit = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL")
          resolve({ code: null, signal: "SIGKILL", timedOut: true })
        }, 60_000)
        child.once("exit", (code, signal) => {
          clearTimeout(timer)
          resolve({ code, signal })
        })
      })
      return { ...started, pid: instance.child?.pid ?? null, installer: { exit, log: tail(log) } }
    },
    async cloneState(from, to) {
      if (instances.get(to)?.home) throw new Error(`connect instance ${to} already has a home`)
      const home = await homeFor(to, from)
      instances.set(to, { id: to, home, child: undefined, log: "", exit: undefined })
      return { id: to, home, stateFile: path.join(home, "connect", "state.json") }
    },
    async signal(id, signal) {
      const instance = instances.get(id)
      if (!instance?.child) throw new Error(`no connect instance ${id}`)
      if (running(instance.child)) instance.child.kill(signal)
      return instance
    },
    async waitExit(id, timeoutMs) {
      const instance = instances.get(id)
      if (!instance?.child) throw new Error(`no connect instance ${id}`)
      if (instance.exit) return instance.exit
      const timeout = new Promise((resolve) => setTimeout(() => resolve(undefined), timeoutMs))
      return await Promise.race([instance.exited, timeout])
    },
    async status(id) {
      const instance = instances.get(id)
      if (!instance) return undefined
      const stateFile = path.join(instance.home, "connect", "state.json")
      const state = await fs.readFile(stateFile, "utf8").then((text) => JSON.parse(text)).catch(() => null)
      const invitationTokenPresent = await fs.stat(path.join(instance.home, "invitation.token")).then(() => true, () => false)
      return {
        id,
        home: instance.home,
        pid: running(instance.child) ? instance.child.pid : null,
        running: running(instance.child),
        exit: instance.exit ?? null,
        state,
        invitationTokenPresent,
        log: tail(instance.log),
      }
    },
    /** The manager's exec seam for the PATH shims: `systemctl`, `loginctl`, `launchctl` as the instance's machine answers them. */
    async machineExec(id, file, args) {
      const instance = instances.get(id)
      if (!instance?.machine) throw new Error(`connect instance ${id} has no machine`)
      return await instance.machine.manager.run(file, args)
    },
    async machineService(id) {
      const instance = instances.get(id)
      if (!instance?.machine) throw new Error(`connect instance ${id} has no machine`)
      return instance.machine.manager.service()
    },
    async machineReboot(id) {
      const instance = instances.get(id)
      if (!instance?.machine) throw new Error(`connect instance ${id} has no machine`)
      return await instance.machine.manager.reboot()
    },
    async listeningPorts(id) {
      const instance = instances.get(id)
      if (!instance?.child?.pid) throw new Error(`connect instance ${id} is not running`)
      // The host's loopback listener binds an OS-chosen port and nothing
      // reports it, so the fixture reads the process's listening sockets.
      const { stdout } = await execFileAsync("lsof", ["-a", "-p", String(instance.child.pid), "-iTCP", "-sTCP:LISTEN", "-P", "-n", "-Fn"])
      return [...stdout.matchAll(/^n(?:127\.0\.0\.1|localhost|\*):(\d+)$/gm)].map((match) => Number(match[1]))
    },
    async stopAll() {
      for (const instance of instances.values()) {
        await instance.machine?.manager.dispose()
        const child = instance.child
        if (!running(child)) continue
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            child.kill("SIGKILL")
            resolve()
          }, 8_000)
          child.once("exit", () => {
            clearTimeout(timer)
            resolve()
          })
          child.kill("SIGTERM")
        })
      }
    },
  }
}

/**
 * Which of a process's listeners is the host runtime listener: the one that
 * answers a workspace route with the runtime's own relay-token refusal.
 */
async function findHostListener(ports, workspaceId) {
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}/workspaces/${encodeURIComponent(workspaceId)}/session`
    const response = await fetch(url, { signal: AbortSignal.timeout(3_000) }).catch(() => undefined)
    if (!response) continue
    const body = await response.json().catch(() => undefined)
    const code = body?.error?.code
    if (code === "relay_host_token_required" || code === "workspace_not_served") return `http://127.0.0.1:${port}`
  }
  return undefined
}

/**
 * Mounts the connect-mode fixture routes on the control plane app.
 *
 * `/__fixture/tunnel/deliver` delivers a request to the host runtime the way
 * the relay and the host's tunnel client would between them: the relay's
 * forward-header treatment (its `Authorization` replaced by the given Relay
 * Host Token, `x-workspace-id` and `x-forwarded-by: workspace-relay` set,
 * client-controlled forwarding headers dropped), then the host side's
 * surface selection and loopback replay header strip, landing on the
 * process's own loopback listener. What it bypasses is the relay's
 * role-by-method rule, which is the point: the runtime's answer to a viewer
 * write is the runtime's. What it does not bypass is the runtime's stamp
 * verification — the token is verified against the relay's JWKS like any
 * other.
 */
export function connectFixtureRoutes(app, ctx) {
  const relayHostKid = ctx.relayHostPublicKey.then((key) => deriveRelayHostKid(key))

  app.post("/__fixture/connect/start", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.id !== "string" || !body.id) return c.json({ error: "id is required" }, 400)
    try {
      return c.json(await ctx.instances.start({
        id: body.id,
        ...(typeof body.token === "string" ? { token: body.token } : {}),
        ...(Array.isArray(body.roots) ? { roots: body.roots } : {}),
        ...(typeof body.name === "string" ? { name: body.name } : {}),
        ...(typeof body.cloneOf === "string" ? { cloneOf: body.cloneOf } : {}),
        ...(body.service === "fake-systemd" ? { service: body.service } : {}),
      }))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })
  // The machine an instance was installed on as a service: the shims on the
  // installing process's PATH land here, and a spec reads and reboots it.
  app.post("/__fixture/machine/exec", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.id !== "string" || typeof body.file !== "string" || !Array.isArray(body.args)) {
      return c.json({ error: "id, file and args are required" }, 400)
    }
    try {
      return c.json(await ctx.instances.machineExec(body.id, body.file, body.args.map(String)))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })
  app.get("/__fixture/machine/service", async (c) => {
    try {
      return c.json(await ctx.instances.machineService(c.req.query("id") ?? ""))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 404)
    }
  })
  app.post("/__fixture/machine/reboot", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    try {
      return c.json(await ctx.instances.machineReboot(body.id))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })
  app.post("/__fixture/connect/clone-state", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (typeof body.from !== "string" || typeof body.to !== "string") return c.json({ error: "from and to are required" }, 400)
    try {
      return c.json(await ctx.instances.cloneState(body.from, body.to))
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 409)
    }
  })
  app.post("/__fixture/connect/stop", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    await ctx.instances.signal(body.id, "SIGTERM")
    const exit = await ctx.instances.waitExit(body.id, Number(body.timeoutMs) || 30_000)
    return c.json({ id: body.id, exit: exit ?? null })
  })
  // SIGSTOP/SIGCONT: an instance frozen mid-run can neither beat nor close
  // its own tunnels, so whatever closes them is the relay's own doing.
  app.post("/__fixture/connect/signal", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    if (body.signal !== "SIGSTOP" && body.signal !== "SIGCONT") return c.json({ error: "signal must be SIGSTOP or SIGCONT" }, 400)
    await ctx.instances.signal(body.id, body.signal)
    return c.json({ id: body.id, signal: body.signal })
  })
  // `acquire` from a copied state dir without a serving process: the cloned
  // key claims the next generation through the real machine-signed transport,
  // which is what a second instance does first on start.
  app.post("/__fixture/connect/acquire", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const status = await ctx.instances.status(body.id)
    if (!status?.state?.enrollment) return c.json({ error: `instance ${body.id} has no enrolled state` }, 409)
    const state = status.state
    const transport = createMachineSignedTransport({
      controlPlaneUrl: state.control_plane_url,
      keys: await hostKeyPairFromJwk(state.private_key_jwk),
      enrollmentId: state.enrollment.enrollment_id,
      hostId: state.host_id,
      keyVersion: state.enrollment.key_version,
      fetch: (input, init) => fetch(input, init),
    })
    return c.json(await transport.acquire())
  })
  app.post("/__fixture/connect/kill", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    await ctx.instances.signal(body.id, "SIGKILL")
    const exit = await ctx.instances.waitExit(body.id, Number(body.timeoutMs) || 10_000)
    return c.json({ id: body.id, exit: exit ?? null })
  })
  app.post("/__fixture/connect/wait-exit", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const exit = await ctx.instances.waitExit(body.id, Number(body.timeoutMs) || 30_000)
    return c.json({ id: body.id, exit: exit ?? null })
  })
  app.get("/__fixture/connect/status", async (c) => {
    const status = await ctx.instances.status(c.req.query("id") ?? "")
    if (!status) return c.json({ error: "unknown instance" }, 404)
    return c.json(status)
  })

  app.get("/__fixture/faults", (c) => c.json(ctx.faults.state))
  app.post("/__fixture/faults/redeem-response-drop", (c) => {
    ctx.faults.setRedeemResponseDrop(c.req.query("on") !== "0")
    return c.json(ctx.faults.state)
  })
  app.post("/__fixture/faults/control-plane-outage", (c) => {
    ctx.faults.setControlPlaneOutage(c.req.query("on") !== "0", c.req.query("resolver") === "1")
    return c.json(ctx.faults.state)
  })

  // A Relay Host Token whose parent Runtime Access Token is recorded with the
  // authority, so the relay's revocation lookup and the runtime's session
  // authority both see a live parent. Signed with the relay's own key under
  // the kid the relay publishes, which is what the host verifies it against.
  app.get("/__fixture/mint-rht", async (c) => {
    const role = c.req.query("role")
    const workspaceId = c.req.query("workspaceId")
    const hostId = c.req.query("hostId")
    const subject = c.req.query("subject") ?? ctx.ownerSubject
    if (role !== "viewer" && role !== "editor" && role !== "owner" && role !== "admin") {
      return c.json({ error: "role must be one of viewer|editor|owner|admin" }, 400)
    }
    if (!workspaceId || !hostId) return c.json({ error: "workspaceId and hostId are required" }, 400)
    const actorAuth = ctx.authFor(subject)
    const actor = await ctx.authority.usersMe(actorAuth)
    const now = Date.now()
    const parentJti = `fixture_rat_${now}_${Math.random().toString(36).slice(2, 8)}`
    const parent = {
      principalKind: "user",
      actorId: actor.actor_id,
      actorKind: actor.actor_kind,
      actorPublicId: actor.actor_public_id,
      actorName: actor.actor_name,
      orgId: ctx.orgId,
      workspaceId,
      hostId,
      role,
    }
    const runtimeAccessToken = await mintRuntimeAccessToken(
      { ...parent, ttlSeconds: 120, jti: parentJti, now },
      ctx.runtimePrivateKey,
      "EdDSA",
    )
    // Recorded as the actor: the authority only lets a principal record its
    // own token, and refuses a role above the actor's workspace role.
    await ctx.authority.recordRuntimeAccessToken(actorAuth, {
      jti: parentJti,
      workspaceId,
      hostId,
      actorId: actor.actor_id,
      actorKind: actor.actor_kind,
      role,
      expiresAt: now + 120_000,
    })
    const relayHostToken = await mintRelayHostToken(
      {
        ...parent,
        access: "user-hosted",
        backing: "local-worktree",
        parentJti,
        ttlSeconds: 60,
        now,
        kid: await relayHostKid,
      },
      ctx.relayHostPrivateKey,
      "EdDSA",
    )
    return c.json({ role, runtimeAccessToken, relayHostToken, parentJti, actor })
  })

  // A Host Tunnel Token from the control plane's own signer for a named
  // serving generation: what a superseded instance still holds after a newer
  // one acquired. The relay's admission answer to it is the fence.
  app.get("/__fixture/mint-htt", async (c) => {
    const enrollmentId = c.req.query("enrollmentId")
    const hostId = c.req.query("hostId")
    const workspaceId = c.req.query("workspaceId")
    const generation = Number(c.req.query("generation"))
    if (!enrollmentId || !hostId || !workspaceId || !Number.isInteger(generation)) {
      return c.json({ error: "enrollmentId, hostId, workspaceId and generation are required" }, 400)
    }
    const minted = await ctx.hostTunnelTokenSigner({
      subject: ctx.ownerSubject,
      hostId,
      workspaceIds: [workspaceId],
      enrollmentId,
      generation,
    })
    return c.json(minted)
  })

  app.post("/__fixture/tunnel/deliver", async (c) => {
    const body = await c.req.json().catch(() => ({}))
    const { instance, workspaceId, relayHostToken, method, path: requestPath } = body
    if (typeof instance !== "string" || typeof workspaceId !== "string" || typeof relayHostToken !== "string" || typeof requestPath !== "string") {
      return c.json({ error: "instance, workspaceId, relayHostToken and path are required" }, 400)
    }
    const ports = await ctx.instances.listeningPorts(instance)
    const localBaseUrl = await findHostListener(ports, workspaceId)
    if (!localBaseUrl) return c.json({ error: `no host runtime listener among ports ${ports.join(", ")}` }, 409)
    const target = hostServingSurface({ localBaseUrl, workspaceId, path: requestPath })
    if (target.kind === "deny") return c.json({ error: "the host surface denies this path" }, 403)
    const inbound = new Headers(body.headers ?? {})
    const forwarded = workspaceRelayForwardHeaders(inbound, relayHostToken, workspaceId, { userHosted: true })
    const replayed = loopbackReplayHeaders(Object.fromEntries(forwarded.entries()))
    const response = await fetch(target.url, {
      method: typeof method === "string" ? method : "GET",
      headers: replayed,
      ...(body.body !== undefined ? { body: JSON.stringify(body.body) } : {}),
      signal: AbortSignal.timeout(30_000),
    })
    const text = await response.text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      json = undefined
    }
    return c.json({ status: response.status, headers: Object.fromEntries(response.headers.entries()), json, text, localBaseUrl })
  })
}

export async function relayHostPublicKeyFrom(privateJwk) {
  const { d: _d, ...publicJwk } = privateJwk
  return await importJWK(publicJwk, "EdDSA")
}

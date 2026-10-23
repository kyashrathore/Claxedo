import fs from "node:fs/promises"
import os from "node:os"
import { CLAXEDO_DAEMON_PROTOCOL } from "@claxedo/helpers/claxedo-daemon"
import { machineDisplayName } from "@claxedo/helpers/machine-name"
import { DECISION_EXIT_CODE, HostConnectDecisionError, readInvitation, redeemInvitation } from "@claxedo/host-connector/bootstrap"
import { createHostKeyPair, hostKeyPairFromJwk, newHostId } from "@claxedo/host-connector/host-identity"
import { ControlPlaneUrlError, HostEndpointUrlError, newHostState, type HostState, type HostStateStore } from "@claxedo/host-connector/host-state"
import { REDEEM_REQUEST_TIMEOUT_MS } from "@claxedo/host-connector/machine-transport"
import { CLAXEDO_MIGRATION_JOURNAL, configureClaxedoSchema } from "@claxedo/server-core/platform/db/index"
import { config } from "../config"
import { errorMessage } from "../json"
import { connectUsage, parseConnectArgs, type ConnectArgs } from "../connect/args"
import { defaultHostDeps, runHost, withBootstrapRetry, type HostDeps } from "../connect/host"
import { desktopDaemonDiscoveryFiles, desktopDaemonState, type DesktopDaemonState } from "../connect/desktop-daemon"
import { connectPaths, connectStateStore } from "../connect/paths"
import { defaultServiceDeps, serviceKind, startService, uninstallService, writeServiceUnit, type ServiceDeps } from "../connect/service"
import { defaultPairingDeps, pair, reportPairing, type PairingDeps } from "../connect/pair"
import { reportMachine } from "../connect/report"

export type ConnectDeps = {
  host: HostDeps
  service: () => ServiceDeps
  store: HostStateStore
  paths: ReturnType<typeof connectPaths>
  controlPlaneUrl: string
  displayName: string
  removeDir: (dir: string) => Promise<void>
  /** What the desktop app's local daemon on this machine turned out to be. */
  desktopDaemon: () => Promise<DesktopDaemonState>
  pairing: PairingDeps
}

export function defaultConnectDeps(): ConnectDeps {
  const paths = connectPaths()
  return {
    host: defaultHostDeps(),
    service: defaultServiceDeps,
    store: connectStateStore(),
    paths,
    controlPlaneUrl: config().controlPlaneUrl,
    displayName: machineDisplayName(process.platform),
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    desktopDaemon: () => desktopDaemonState({ files: desktopDaemonDiscoveryFiles(process.env, os.homedir()) }),
    pairing: defaultPairingDeps(),
  }
}

export const connectHelp = `${connectUsage}

  --pair CODE           connect through the pairing code Claxedo's "Connect a machine…" shows; this machine waits for its owner to approve it and then shares the folder this command runs in (on a machine already connected, it asks to share that folder instead)
  --token-file F        redeem an invitation from F (minted by \`claxedo host invite\`); the file is removed once the enrollment is on disk
  --root DIR            serve only under DIR (repeatable, absolute as this machine writes it); the effective roots are the owner's scope ∩ these
  --name N              this machine's display name at first enrollment (default: the name this computer answers to); a name the invitation carries wins
  --direct on|off       whether this machine also listens, TLS only, on its private-network addresses (LAN, tailnet) so the owner's desktop app on the same network reaches it without the relay; on by default, remembered until changed, and off means nothing listens and no route is reported
  --install-service     enroll if --token-file is given, then install and start a user service that runs \`claxedo connect --foreground\`, restarting it when it already runs
  --uninstall-service   stop and remove that service
  --foreground          serve in this process (the default when no service flag is given)
  --alongside-desktop   serve even while the Claxedo desktop app's daemon is running on this machine; without it, connect refuses to start beside a live daemon (exit 78), since the desktop serves this machine under its own enrollment when its remote access is on
  --reset               delete the host state — key, enrollment and endpoints — after printing what goes; a fresh state is a fresh host id
  --reset-roots         forget where each root resolved when first served, so a root that has since become a symlink is served at its new target; a running connect must be restarted to pick this up

Exit codes: 0 after SIGTERM/SIGINT drained every runtime and tunnel; 78 when the
control plane decided against this machine (invitation redeemed/expired/revoked,
enrollment revoked, generation superseded) — a service manager must not restart
into it; 1 for anything else, including a control plane unreachable for 5 minutes
during enrollment or acquire.

The service is a systemd --user unit on Linux (Restart=on-failure,
RestartPreventExitStatus=78), a LaunchAgent on macOS
(KeepAlive/SuccessfulExit=false; exit 78 unloads the agent until the next
login) and a per-user scheduled task on Windows (ClaxedoConnect, at logon,
restarting after any failure; exit 78 disables the task until
\`schtasks /Change /TN ClaxedoConnect /Enable\`). On Linux the unit is written and recorded but NOT started, exit 78,
until \`loginctl enable-linger <user>\` is on and XDG_RUNTIME_DIR reaches the
user manager — the state a cloud-init run without a login session is in. On
Windows the task runs only while its user is logged on, and an ended task is
killed without draining. The Linux and macOS units run with the PATH of the
shell that installed them, so the service finds the tools that shell finds;
the Windows task has its user's own environment. A user service isolates this process from OTHER users
only. An agent running as the same user can read the key file; what the key can
do is serve the owner-assigned folders under the roots, nothing about the account.

Each root's canonical path is recorded the first time it is resolved; a root
that later resolves elsewhere (created as a symlink after the fact) serves
nothing until --reset-roots or a new scope from the owner re-records it.

State lives in ${connectPaths().stateFile} (CLAXEDO_HOME moves it).`

function mintHint(controlPlaneUrl: string) {
  return [
    "This machine is not enrolled and no --token-file was given.",
    "On a signed-in laptop, mint an invitation and copy the token here:",
    "  claxedo host invite --name <machine> --root <dir>",
    `then run: claxedo connect --token-file <file> [--root <dir>]   (control plane: ${controlPlaneUrl})`,
  ].join("\n")
}

async function loadHostState(deps: ConnectDeps): Promise<HostState | undefined> {
  const loaded = await deps.store.load().catch((error: unknown) => {
    if (error instanceof HostEndpointUrlError) {
      // A recorded relay/authority endpoint that fails the entry checks was
      // edited on disk or written before they existed; it cannot be re-learned
      // from a beat the file never loads for.
      throw new HostConnectDecisionError(
        `${errorMessage(error)}; the recorded endpoint in ${deps.paths.stateFile} is refused, so run \`claxedo connect --reset\` and redeem a new invitation`,
        { cause: error },
      )
    }
    if (!(error instanceof ControlPlaneUrlError)) throw error
    // A host enrolled against this endpoint before it was refused. Its key is
    // bound to that enrollment, so the way out is a new host id, not an edit.
    throw new HostConnectDecisionError(
      `${errorMessage(error)}; this machine is enrolled against it in ${deps.paths.stateFile}, so run \`claxedo connect --reset\` and redeem a new invitation`,
      { cause: error },
    )
  })
  return loaded ? deps.store.finishPendingCleanup(loaded) : undefined
}

async function resetHostState(deps: ConnectDeps, log: (line: string) => void) {
  const state = await deps.store.load().catch((error: unknown) => {
    log(`state file unreadable (${errorMessage(error)}); removing it anyway`)
    return undefined
  })
  log(`Removing ${deps.paths.dir}:`)
  if (state) {
    log(`  host id ${state.host_id} and its private key`)
    if (state.enrollment) log(`  enrollment ${state.enrollment.enrollment_id} (${state.enrollment.enrolled_via})`)
    if (state.bootstrap) log(`  pending redeem of invitation ${state.bootstrap.invitation_id}`)
    if (state.service) log(`  note: the ${state.service.kind} service at ${state.service.unit} is left installed; run \`claxedo connect --uninstall-service\` to remove it`)
  }
  log(`  workspace state under ${deps.paths.storageRoot}`)
  await deps.removeDir(deps.paths.dir)
  log("Done. The next `claxedo connect --token-file` enrolls this machine under a new host id.")
  return 0
}

async function resetRoots(deps: ConnectDeps, log: (line: string) => void) {
  const state = await deps.store.load()
  if (!state) {
    log(`No connect host on this machine (${deps.paths.stateFile} absent); nothing to reset.`)
    return 0
  }
  const recorded = Object.entries(state.roots_canonical ?? {})
  if (recorded.length === 0) {
    log("No root has been resolved yet; nothing to reset.")
    return 0
  }
  const { roots_canonical: _cleared, ...rest } = state
  await deps.store.save(rest)
  log("Forgot where these roots first resolved:")
  for (const [root, canonical] of recorded) log(`  ${root}${canonical === root ? "" : ` (was ${canonical})`}`)
  log("Each is re-recorded as it resolves now, the next time an assignment under it is prepared.")
  if (state.run) log(`A connect process (pid ${state.run.pid}) may still hold the old record: restart it${state.service ? ` (${state.service.kind} ${state.service.unit})` : ""}.`)
  return 0
}

async function enroll(deps: ConnectDeps, args: ConnectArgs, existing: HostState | undefined, log: (line: string) => void) {
  const tokenFile = args.tokenFile ?? existing?.bootstrap?.token_file
  if (!tokenFile) {
    log(mintHint(deps.controlPlaneUrl))
    return undefined
  }
  const invitation = await readInvitation(deps.store.fs, tokenFile)
  let state = existing
  let keys
  if (state) {
    // The state's URL is the one the pending redeem resumes against; a state
    // recorded against another control plane would send this invitation's
    // secret where it cannot be redeemed.
    if (invitation.controlPlaneUrl !== state.control_plane_url) {
      throw new HostConnectDecisionError(
        `a redeem against ${state.control_plane_url} is still pending; run \`claxedo connect --reset\` to enroll against ${invitation.controlPlaneUrl} instead`,
        {},
      )
    }
    keys = await hostKeyPairFromJwk(state.private_key_jwk)
  } else {
    const created = await createHostKeyPair()
    keys = created
    state = newHostState({
      hostId: newHostId(),
      privateKeyJwk: created.privateKeyJwk,
      controlPlaneUrl: invitation.controlPlaneUrl,
      cliRoots: args.roots,
      storageRoot: deps.paths.storageRoot,
    })
  }
  const pending = state
  const outcome = await withBootstrapRetry(deps.host, "redeem", ({ timeoutMs }) =>
    redeemInvitation({
      tokenFile,
      invitation,
      store: deps.store,
      state: pending,
      keys,
      fetch: deps.host.fetch,
      displayName: args.name ?? deps.displayName,
      requestTimeoutMs: Math.min(REDEEM_REQUEST_TIMEOUT_MS, timeoutMs),
    }),
  )
  const enrollment = outcome.state.enrollment
  const owner = enrollment?.owner_display ? ` for ${enrollment.owner_display}` : ""
  log(`${outcome.resumed ? "Resumed" : "Enrolled"} as ${enrollment?.enrollment_id}${owner} (host ${outcome.state.host_id})`)
  return outcome.state
}

async function installAndStartService(deps: ConnectDeps, state: HostState, args: ConnectArgs, log: (line: string) => void) {
  const service = deps.service()
  const installed = await writeServiceUnit(service, { alongsideDesktop: args.alongsideDesktop })
  await deps.store.save({ ...state, service: installed })
  const start = await startService(service, installed)
  for (const line of start.lines) log(line)
  if (start.started) return 0
  await reportMachine(state, { fetch: deps.host.fetch, log, blocked: start.blocked })
  return DECISION_EXIT_CODE
}

/** A live desktop daemon owns this machine; one already enrolled tells its owner why it is not serving too. */
async function refuseBesideDesktop(deps: ConnectDeps, daemon: Extract<DesktopDaemonState, { state: "live" }>): Promise<never> {
  const enrolled = await deps.store.load().catch(() => undefined)
  if (enrolled?.enrollment) {
    const fix = enrolled.service ? "claxedo connect --install-service --alongside-desktop" : "claxedo connect --alongside-desktop"
    await reportMachine(enrolled, { fetch: deps.host.fetch, log: deps.host.log, blocked: { reason: "desktop_daemon", fix } })
  }
  throw new HostConnectDecisionError(
    `the Claxedo desktop app's daemon is running on this machine (pid ${daemon.pid}, port ${daemon.port}, ${daemon.file}); the desktop serves this machine under its own enrollment when its remote access is on, so pass --alongside-desktop to run \`claxedo connect\` as a second machine beside it`,
    {},
  )
}

/**
 * The command, returning the process exit code rather than exiting: the
 * integration tests run it in-process, and `index.ts` maps the number.
 */
export async function connect(argv: string[], deps: ConnectDeps = defaultConnectDeps()): Promise<number> {
  // The runtimes this host serves read the machine's `claxedo.db`; a connected
  // host composes no plugin, so the host journal is its whole schema.
  configureClaxedoSchema({ journals: [CLAXEDO_MIGRATION_JOURNAL] })
  const log = deps.host.log
  let args: ConnectArgs
  try {
    args = parseConnectArgs(argv)
  } catch (error) {
    log(errorMessage(error))
    return 1
  }
  try {
    if (args.reset) return await resetHostState(deps, log)
    if (args.resetRoots) return await resetRoots(deps, log)
    if (args.uninstallService) {
      const state = await deps.store.load()
      for (const line of await uninstallService(deps.service(), state?.service)) log(line)
      if (state?.service) {
        const { service: _removed, ...rest } = state
        await deps.store.save(rest)
      }
      return 0
    }
    // Before the redeem: an invitation spent on a platform with no service to install is lost.
    if (args.installService) serviceKind(deps.service().platform)

    if (!args.alongsideDesktop) {
      const daemon = await deps.desktopDaemon()
      // Only `absent` means nothing owns this machine. The other three each
      // name an owner, and starting a competing one over the same data
      // directory would make the damage worse than whatever is wrong with it.
      if (daemon.state === "live") await refuseBesideDesktop(deps, daemon)
      if (daemon.state === "unresponsive") {
        throw new HostConnectDecisionError(
          `the Claxedo desktop app's daemon is published on this machine (pid ${daemon.pid}, port ${daemon.port}, ${daemon.file}) but is not answering; it still owns that data directory, so recover it from the desktop app or stop that process yourself before running \`claxedo connect\``,
          {},
        )
      }
      if (daemon.state === "incompatible") {
        throw new HostConnectDecisionError(
          `the Claxedo desktop app's daemon on this machine speaks management protocol ${daemon.protocol} and this CLI speaks ${CLAXEDO_DAEMON_PROTOCOL} (${daemon.file}); update both and restart the desktop app before running \`claxedo connect\``,
          {},
        )
      }
    }

    let state = await loadHostState(deps)
    if (args.pair !== undefined) {
      const pairing = { host: deps.host, store: deps.store, paths: deps.paths, controlPlaneUrl: deps.controlPlaneUrl, removeDir: deps.removeDir, pairing: deps.pairing, log }
      const paired = await pair(args, state, pairing)
      if (typeof paired === "number") return paired
      if (!args.installService) return await runHost({ store: deps.store, state: paired.state, deps: deps.host })
      const installed = await installAndStartService(deps, paired.state, args, log)
      return installed === 0 ? await reportPairing(paired.state, paired.folder, pairing) : installed
    }
    if (state?.enrollment && args.tokenFile) {
      throw new HostConnectDecisionError(
        `this machine is already enrolled as ${state.enrollment.enrollment_id}; run \`claxedo connect --reset\` before redeeming another invitation`,
        {},
      )
    }
    if (state && args.roots.length > 0 && JSON.stringify(state.cli_roots) !== JSON.stringify(args.roots)) {
      state = { ...state, cli_roots: args.roots }
      await deps.store.save(state)
    }
    if (!state?.enrollment) {
      state = await enroll(deps, args, state, log)
      if (!state) return DECISION_EXIT_CODE
    }
    if (args.direct !== undefined && (state.direct?.enabled ?? true) !== args.direct) {
      state = { ...state, direct: { ...state.direct, enabled: args.direct } }
      await deps.store.save(state)
    }

    if (args.installService) return await installAndStartService(deps, state, args, log)
    return await runHost({ store: deps.store, state, deps: deps.host })
  } catch (error) {
    log(errorMessage(error))
    return error instanceof HostConnectDecisionError ? error.exitCode : 1
  }
}

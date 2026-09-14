import fs from "node:fs/promises"
import os from "node:os"
import { DECISION_EXIT_CODE, HostConnectDecisionError, redeemInvitation } from "@claxedo/host-connector/bootstrap"
import { createHostKeyPair, hostKeyPairFromJwk, newHostId } from "@claxedo/host-connector/host-identity"
import { newHostState, type HostState, type HostStateStore } from "@claxedo/host-connector/host-state"
import { config } from "../config"
import { errorMessage } from "../json"
import { connectUsage, parseConnectArgs, type ConnectArgs } from "../connect/args"
import { defaultHostDeps, runHost, withBootstrapRetry, type HostDeps } from "../connect/host"
import { desktopDaemonDiscoveryFiles, liveDesktopDaemon, type LiveDesktopDaemon } from "../connect/desktop-daemon"
import { connectPaths, connectStateStore } from "../connect/paths"
import { defaultServiceDeps, startService, uninstallService, writeServiceUnit, type ServiceDeps } from "../connect/service"

export type ConnectDeps = {
  host: HostDeps
  service: () => ServiceDeps
  store: HostStateStore
  paths: ReturnType<typeof connectPaths>
  controlPlaneUrl: string
  displayName: string
  removeDir: (dir: string) => Promise<void>
  /** The desktop app's local daemon on this machine, when one is alive. */
  desktopDaemon: () => Promise<LiveDesktopDaemon | undefined>
}

export function defaultConnectDeps(): ConnectDeps {
  const paths = connectPaths()
  return {
    host: defaultHostDeps(),
    service: defaultServiceDeps,
    store: connectStateStore(),
    paths,
    controlPlaneUrl: config().controlPlaneUrl,
    displayName: os.hostname(),
    removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
    desktopDaemon: () => liveDesktopDaemon({ files: desktopDaemonDiscoveryFiles(process.env, os.homedir()) }),
  }
}

export const connectHelp = `${connectUsage}

  --token-file F        redeem an invitation from F (minted by \`claxedo host invite\`); the file is removed once the enrollment is on disk
  --root DIR            serve only under DIR (repeatable); the effective roots are the owner's scope ∩ these
  --name N              this machine's display name at first enrollment (default: the hostname)
  --install-service     enroll if --token-file is given, then install and start a user service that runs \`claxedo connect --foreground\`
  --uninstall-service   stop and remove that service
  --foreground          serve in this process (the default when no service flag is given)
  --alongside-desktop   serve even while the Claxedo desktop app's daemon is running on this machine; without it, connect refuses to start beside a live daemon (exit 78), since the desktop serves this machine under its own enrollment when its remote access is on
  --reset               delete the host state — key, enrollment and endpoints — after printing what goes; a fresh state is a fresh host id

Exit codes: 0 after SIGTERM/SIGINT drained every runtime and tunnel; 78 when the
control plane decided against this machine (invitation redeemed/expired/revoked,
enrollment revoked, generation superseded) — a service manager must not restart
into it; 1 for anything else, including a control plane unreachable for 5 minutes
during enrollment or acquire.

The service is a systemd --user unit on Linux (Restart=on-failure,
RestartPreventExitStatus=78) and a LaunchAgent on macOS
(KeepAlive/SuccessfulExit=false; exit 78 unloads the agent until the next
login). On Linux the unit is written and recorded but NOT started, exit 78,
until \`loginctl enable-linger <user>\` is on and XDG_RUNTIME_DIR reaches the
user manager — the state a cloud-init run without a login session is in. A user service isolates this process from OTHER users
only. An agent running as the same user can read the key file; what the key can
do is serve the owner-assigned folders under the roots, nothing about the account.

State lives in ${connectPaths().stateFile} (CLAXEDO_HOME moves it).`

function mintHint(controlPlaneUrl: string) {
  return [
    "This machine is not enrolled and no --token-file was given.",
    "On a signed-in laptop, mint an invitation and copy the token here:",
    "  claxedo host invite --name <machine> --root <dir>",
    `then run: claxedo connect --token-file <file> [--root <dir>]   (control plane: ${controlPlaneUrl})`,
  ].join("\n")
}

async function loadState(deps: ConnectDeps): Promise<HostState | undefined> {
  const loaded = await deps.store.load()
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

async function enroll(deps: ConnectDeps, args: ConnectArgs, existing: HostState | undefined, log: (line: string) => void) {
  const tokenFile = args.tokenFile ?? existing?.bootstrap?.token_file
  if (!tokenFile) {
    log(mintHint(deps.controlPlaneUrl))
    return undefined
  }
  let state = existing
  let keys
  if (state) {
    keys = await hostKeyPairFromJwk(state.private_key_jwk)
  } else {
    const created = await createHostKeyPair()
    keys = created
    state = newHostState({
      hostId: newHostId(),
      privateKeyJwk: created.privateKeyJwk,
      controlPlaneUrl: deps.controlPlaneUrl,
      cliRoots: args.roots,
      storageRoot: deps.paths.storageRoot,
    })
  }
  const pending = state
  const outcome = await withBootstrapRetry(deps.host, "redeem", () =>
    redeemInvitation({
      tokenFile,
      store: deps.store,
      state: pending,
      keys,
      fetch: deps.host.fetch,
      displayName: args.name ?? deps.displayName,
    }),
  )
  const enrollment = outcome.state.enrollment
  const owner = enrollment?.owner_display ? ` for ${enrollment.owner_display}` : ""
  log(`${outcome.resumed ? "Resumed" : "Enrolled"} as ${enrollment?.enrollment_id}${owner} (host ${outcome.state.host_id})`)
  return outcome.state
}

/**
 * The command, returning the process exit code rather than exiting: the
 * integration tests run it in-process, and `index.ts` maps the number.
 */
export async function connect(argv: string[], deps: ConnectDeps = defaultConnectDeps()): Promise<number> {
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
    if (args.uninstallService) {
      const state = await deps.store.load()
      for (const line of await uninstallService(deps.service(), state?.service)) log(line)
      if (state?.service) {
        const { service: _removed, ...rest } = state
        await deps.store.save(rest)
      }
      return 0
    }

    if (!args.alongsideDesktop) {
      const daemon = await deps.desktopDaemon()
      if (daemon) {
        throw new HostConnectDecisionError(
          `the Claxedo desktop app's daemon is running on this machine (pid ${daemon.pid}, port ${daemon.port}, ${daemon.file}); the desktop serves this machine under its own enrollment when its remote access is on, so pass --alongside-desktop to run \`claxedo connect\` as a second machine beside it`,
          {},
        )
      }
    }

    let state = await loadState(deps)
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

    if (args.installService) {
      const service = deps.service()
      const installed = await writeServiceUnit(service, { alongsideDesktop: args.alongsideDesktop })
      await deps.store.save({ ...state, service: installed })
      const start = await startService(service, installed)
      for (const line of start.lines) log(line)
      return start.started ? 0 : DECISION_EXIT_CODE
    }
    return await runHost({ store: deps.store, state, deps: deps.host })
  } catch (error) {
    log(errorMessage(error))
    return error instanceof HostConnectDecisionError ? error.exitCode : 1
  }
}

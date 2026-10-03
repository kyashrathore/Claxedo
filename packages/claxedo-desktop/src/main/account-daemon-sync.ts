import type { HostedOperationName } from "@claxedo/account-contract"
import type { AccountState } from "./account/account-service"
import type { LazyAccount } from "./account/lazy-account"
import { setupAgentPluginsSignedSync } from "./agent-plugins-signed-sync"
import type { DaemonFetch } from "./daemon-request"
import { setupSessionCleanupGrantSync } from "./session-cleanup-grant-sync"

/** Main's account-backed daemon mirrors share wiring, never account credentials. */
export function setupAccountDaemonSync(input: {
  account: LazyAccount
  daemon: DaemonFetch
  coreOrigin: string | undefined
  log: { info(message: string): void; warn(message: string): void }
}) {
  const common = {
    runAccountOperation: input.account.run,
    daemon: input.daemon,
    log: input.log,
  }
  const plugins = setupAgentPluginsSignedSync({ ...common, enabled: true })
  const cleanup = setupSessionCleanupGrantSync({ ...common, coreOrigin: input.coreOrigin })
  const follow = (state: AccountState) => {
    plugins.follow(state)
    cleanup.follow(state)
  }
  // An adopted daemon can outlive a previous main process. Withdraw any old
  // cleanup identity even on unsigned boot, before restore can install one.
  follow(input.account.state())
  void input.account.ready.then(() => follow(input.account.state()), () => {})
  return {
    follow,
    operation(name: HostedOperationName) {
      if (name.startsWith("agentPlugins.") && name !== "agentPlugins.runtimeSelf") void plugins.refresh()
    },
    async stop() {
      plugins.stop()
      await cleanup.stop()
    },
  }
}

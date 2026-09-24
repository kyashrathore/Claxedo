import { onCleanup, type JSX, type ParentProps } from "solid-js"
import { filePaneKind } from "@/files"
import { useTranslator } from "@/i18n"
import { useServer } from "@/server"
import { useShellRoute } from "@/shell"
import { useWorkbench } from "@/workbench"
import { createRendererBudget } from "./backend/renderer-budget"
import { useEndTerminalOnClose } from "./close"
import { useNewTerminalCommand } from "./commands"
import { TerminalsContext, type Terminals } from "./context"
import { dictionary } from "./i18n"
import { createTerminalStore } from "./store"
import { createTerminalStoreCache } from "./store-cache"
import { terminalPaneKind } from "./pane"

const STORE_CAP = 8

export function TerminalProvider(props: ParentProps): JSX.Element {
  const server = useServer()
  const workbench = useWorkbench()
  const t = useTranslator(dictionary)
  const cache = createTerminalStoreCache(STORE_CAP, (placementId) =>
    createTerminalStore({ server, placementId, numberedTitle: (number) => t("terminal.title.numbered", { number }) }),
  )
  onCleanup(cache.dispose)
  const terminals: Terminals = {
    placementId: useShellRoute().placementId,
    renderers: createRendererBudget(),
    store: cache.storeFor,
    retain: cache.retain,
    defaultTitle: () => t("terminal.title"),
    open: (state, paneId) => {
      if (paneId) workbench.replacePane(paneId, terminalPaneKind, state)
      else workbench.openPane(terminalPaneKind, state)
    },
    openFile: (placementId, target) => {
      workbench.openPane(filePaneKind, { placementId, ...target })
    },
  }
  useNewTerminalCommand(terminals)
  useEndTerminalOnClose(terminals)
  return <TerminalsContext.Provider value={terminals}>{props.children}</TerminalsContext.Provider>
}

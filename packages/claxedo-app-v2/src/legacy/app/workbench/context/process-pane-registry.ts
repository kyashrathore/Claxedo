import { createComponent, createRoot, createSignal, getOwner, type Accessor } from "solid-js"
import {
  ProcessPaneProvider as FeatureProcessPaneProvider,
  useProcessPane as useFeatureProcessPane,
  type ProcessPaneProviderProps,
} from "@/features/processes/providers"
import { createRefCountedResourceCache } from "@/platform/sync/live-resource-cache"

export type WorkspaceProcessPane = ReturnType<typeof useFeatureProcessPane>

/** See the note on the same alias in `workbench/terminal/terminal-new-view.tsx`. */
type WorkspaceDirectoryRef = string

type Holder = { isOpen: Accessor<boolean> }

type Instance = {
  api: WorkspaceProcessPane
  hold: (holder: Holder) => () => void
}

export type ProcessPaneInstanceProps = Omit<ProcessPaneProviderProps, "directory" | "isOpen">

const instances = createRefCountedResourceCache<Instance>()

/**
 * One live process pane per workspace directory, shared by every mounted
 * consumer (the navigator sidebar's Processes tab and the workspace panel's
 * body). The feature provider subscribes to the process event stream, owns
 * the persisted store for its directory, and answers the shared
 * `pendingAction` slot, so two instances for one directory would double every
 * one of those. The instance lives in its own root, so the consumer that
 * created it may unmount while another still holds it; the root inherits the
 * creator's context because the feature provider reads the dialog context
 * during construction.
 *
 * `isOpen` is the union of every holder's answer: the pane hydrates when any
 * consumer is showing the list.
 */
export function acquireProcessPane(input: {
  directory: WorkspaceDirectoryRef
  isOpen: Accessor<boolean>
  props: ProcessPaneInstanceProps
}): { api: WorkspaceProcessPane; release: () => void } {
  const owner = getOwner()
  const handle = instances.acquire(input.directory, () =>
    createRoot((dispose) => ({
      value: createInstance(input.directory, input.props),
      dispose,
    }), owner),
  )
  const unhold = handle.value.hold({ isOpen: input.isOpen })
  return {
    api: handle.value.api,
    release: () => {
      unhold()
      handle.release()
    },
  }
}

export function processPaneInstanceCount() {
  return instances.size()
}

function createInstance(directory: WorkspaceDirectoryRef, props: ProcessPaneInstanceProps): Instance {
  const [holders, setHolders] = createSignal<Holder[]>([])
  let api: WorkspaceProcessPane | undefined
  createComponent(FeatureProcessPaneProvider, {
    ...props,
    directory,
    isOpen: () => holders().some((holder) => holder.isOpen()),
    get children() {
      api = useFeatureProcessPane()
      return undefined
    },
  })
  if (!api) throw new Error(`ProcessPane for ${directory} did not construct`)
  return {
    api,
    hold: (holder) => {
      setHolders((current) => [...current, holder])
      return () => setHolders((current) => current.filter((entry) => entry !== holder))
    },
  }
}

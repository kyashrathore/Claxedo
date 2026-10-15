import type { Accessor } from "solid-js"
import type { HarnessSelection } from "@/lib/harness-selection"
import type { ComposerKey } from "../store"
import { useHarnessConfig } from "./context"

export function useSelectedHarness(key: Accessor<ComposerKey>): Accessor<HarnessSelection | undefined> {
  const store = useHarnessConfig()
  return () => store.harness(key())
}

import type { AppExtensions } from "./types"
import type { ExtensionConfig } from "./types"
import { cloudStrings } from "@/platform/i18n/cloud-strings"

export function appExtensions(_config: ExtensionConfig): AppExtensions {
  return {
    strings: cloudStrings,
  }
}

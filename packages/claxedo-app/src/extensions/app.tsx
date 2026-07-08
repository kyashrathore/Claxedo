import type { AppExtensions } from "./types"
import type { ClaxedoConfig } from "../index"
import { cloudStrings } from "../i18n/cloud-strings"

export function appExtensions(_config: ClaxedoConfig): AppExtensions {
  return {
    strings: cloudStrings,
  }
}

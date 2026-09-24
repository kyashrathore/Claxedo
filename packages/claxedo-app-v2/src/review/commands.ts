import type { CommandEntry } from "@/shell/types"
import { t } from "./i18n"
import type { Review } from "./store"

export function reviewCommands(review: Review): readonly CommandEntry[] {
  return [
    {
      id: "review.toggleDiffStyle",
      title: () => t("review.style.toggle"),
      when: () => review.placementId() !== undefined,
      run: () => review.toggleStyle(),
    },
  ]
}

import { useTranslator } from "@/i18n"
import { useCommands } from "@/shell"
import { dictionary } from "./i18n"
import type { Review } from "./store"

export function useReviewCommands(review: Review): void {
  const commands = useCommands()
  const t = useTranslator(dictionary)
  commands.register("review", () => [
    {
      id: "review.toggleDiffStyle",
      title: t("review.style.toggle"),
      category: t("review.tab"),
      disabled: review.placementId() === undefined,
      onSelect: () => review.setStyle(review.style() === "unified" ? "split" : "unified"),
    },
  ])
}

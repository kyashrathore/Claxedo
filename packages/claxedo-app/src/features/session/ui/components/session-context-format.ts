import { formatDateTimeMed } from "@/lib/relative-time"

export function createSessionContextFormatter(locale: string) {
  // Arrow properties: `time` is handed to <RawMessage> as a bare prop, and all
  // three read only the captured `locale`.
  return {
    number: (value: number | null | undefined) => {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale)
    },
    percent: (value: number | null | undefined) => {
      if (value === undefined) return "—"
      if (value === null) return "—"
      return value.toLocaleString(locale) + "%"
    },
    time: (value: number | undefined) => {
      if (!value) return "—"
      return formatDateTimeMed(value, locale)
    },
  }
}

export const COMMON_WORDS = {
  "claxedo-tasks.age.now": "just now",
  "claxedo-tasks.age.minutes": "{{count}}m ago",
  "claxedo-tasks.age.hours": "{{count}}h ago",
  "claxedo-tasks.age.days": "{{count}}d ago",
  "claxedo-tasks.age.weeks": "{{count}}w ago",
  "claxedo-tasks.age.year": "in {{count}}",
  "claxedo-tasks.field.required": "required",
  "claxedo-tasks.field.tooLong": "too long",
  "claxedo-tasks.field.tooMany": "too many entries",
  "claxedo-tasks.field.duplicate": "listed twice",
  "claxedo-tasks.field.unknownValue": "not available here; choose another",
  "claxedo-tasks.field.outOfRange": "out of range",
  "claxedo-tasks.field.notAllowed": "not allowed",
  "claxedo-tasks.field.refused": "refused",
  "claxedo-tasks.error.rateLimit": "Too many requests. Wait a moment, then try again.",
} as const

export type TasksCommonKey = keyof typeof COMMON_WORDS

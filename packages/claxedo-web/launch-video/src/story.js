/** The demo session the film follows from shot 3 to the poster. Illustration, not product claims. */
export const PROJECT = "payments"
export const WORKSPACE = "checkout"
export const PROMPT = "Retry the checkout webhook with backoff."
export const REPLY = [
  "I'll wrap the webhook handler in a retry with exponential backoff, then cover it with a test.",
  "Retries back off at 1, 2 and 4 seconds, and all three webhook tests pass on checkout.",
]
export const COMMANDS = ["$ git switch -c webhook-retries", "$ bun test webhook", "✓ 3 pass"]
export const TERMINAL_PROMPT = "ada@checkout payments % "
export const TERMINAL_COMMAND = "git branch --show-current"
export const PHONE_PROMPT = "Open a pull request."
export const PHONE_REPLY = "Opened it: “Retry the checkout webhook with backoff”, ready for review."
export const SESSION_ROWS = [
  { title: "Webhook retries", place: "checkout", placeIcon: "cloud", when: "now", lead: "dot" },
  { title: "Fix refund rounding", place: "studio-mac", placeIcon: "monitor", when: "2h" },
  { title: "Audit idempotency keys", place: "payments", placeIcon: "cloud", when: "1d" },
]
export const TERMINAL_ROW = { title: "Terminal", place: "checkout", placeIcon: "cloud", when: "now", lead: "terminal" }

import type { ErrorMessages } from "./model"

export default {
  auth: ["Sign in again", "Your sign-in expired or was refused. Sign in again to continue."],
  rate_limit: ["Too many requests", "The server is limiting requests. Wait a moment, then try again."],
  network: ["Can't reach the server", "The server could not be reached. Check the connection, then try again."],
  not_found: ["Not found", "This no longer exists. It may have been deleted."],
  conflict: ["Changed elsewhere", "This changed somewhere else first. Reload, then try again."],
  invalid: ["Request refused", "The server refused this request as invalid."],
  internal: ["Something went wrong", "An unexpected error occurred. Try again."],
  signIn: "Sign in",
  retry: "Try again",
  reload: "Reload",
} satisfies ErrorMessages

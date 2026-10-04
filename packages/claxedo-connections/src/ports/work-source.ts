import type { TokenPort } from "./serving.js"

/**
 * `work-source` — the tracker that issues the work a session is doing.
 *
 * Token-served, and deliberately distinct from `docs` even where one provider
 * serves both: Atlassian holds Confluence pages and Jira issues behind one
 * credential, and a connection may be granted either without the other.
 */
export type WorkSourcePort = TokenPort<"work-source">

export const workSourcePort: WorkSourcePort = { capability: "work-source" }

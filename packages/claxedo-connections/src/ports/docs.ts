import type { TokenPort } from "./serving.js"

/**
 * `docs` — read and write documents at the provider.
 *
 * Token-served. Declaring this port is the author's statement that a token
 * minted from this connection is meant to be spent on documents; it is what a
 * connection's frozen grant names and what `resolveForCapability("docs")`
 * matches.
 */
export type DocsPort = TokenPort<"docs">

export const docsPort: DocsPort = { capability: "docs" }

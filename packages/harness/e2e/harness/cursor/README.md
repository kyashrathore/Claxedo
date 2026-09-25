# Scripted Cursor backend

`backend.ts` answers the Cursor SDK's Connect-RPC requests from named scripts. It uses the message and service descriptors bundled in the pinned `@cursor/sdk@1.0.24` package to decode requests and encode replies. The harness does not copy or maintain a protobuf schema.

The SDK exports its public agent API but not every descriptor the backend needs. `descriptors.ts` loads the pinned bundle in an isolated temporary directory, exposes the SDK's internal module loader and the unexported service descriptors there, and removes the directory when the backend closes. It checks the installed version and the exact bundle locations before loading; a changed SDK layout throws instead of silently using guessed messages.

The flow stores a placeholder Cursor account through the product's credential routes and points the local provider configuration at this loopback backend. The daemon projects a workspace-specific broker binding into its runtime. The SDK's access-token exchange currently prevents the daemon flow from finishing: subsequent Connect calls send the exchanged token where the broker expects its signed placeholder.

# Pi RPC transport

Pi has no MCP protocol and no ACP wrapper. The native RPC transport carries Pi's session resume, `get_commands`, extension UI dialogs and notices, steering, and its own session name. Source: pinned Pi 0.85.1 `packages/harness/e2e/.artifacts/pi/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`.

The transport starts only through `HarnessServices.spawn`. A failed RPC exchange makes that launch unusable; it does not prove the operating system process exited. The owner of the process must retire it and report the result. RPC records split on LF, preserving Unicode line separators inside JSON strings, and a response must match both the pending id and command.

The runtime's old Pi adapter remains the only production path until the atomic P3 cutover. This folder is exercised through the contract conformance suite against pinned Pi and the scripted model server.

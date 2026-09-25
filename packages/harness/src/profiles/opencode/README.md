# OpenCode profile

The embedded SDK's plugin hooks accept MCP server and skill transforms per location. Claxedo projects each session's MCP servers through those hooks and scans each projected plugin root's `skills/` directory; no configuration is written into the person's project. The first-party MCP server is requested with the session ID so its callbacks act as that session. A location-wide hook cannot distinguish simultaneous sessions with different launch documents, so the transport refuses conflicting documents in one location.

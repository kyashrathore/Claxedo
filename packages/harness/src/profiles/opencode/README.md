# OpenCode profile

The embedded SDK's plugin hooks accept MCP server and skill transforms per location. Claxedo projects each session's MCP servers through those hooks and loads only the catalog-approved `skillNames` carried by each projected plugin root; no configuration is written into the person's project. Shared MCP servers and skills apply per location, so a projection change reaches every session in that directory. First-party tools use session-scoped registrations to preserve the caller's identity.

The catalog owns skill validation and its diagnostics. Generation metadata persists the required approved names across reloads; the profile expands each name to `<root>/skills/<name>`. The launch policy reads those exact skill directories without discovering siblings or revalidating the catalog verdict. Other harness profiles continue using their native plugin-root loaders.

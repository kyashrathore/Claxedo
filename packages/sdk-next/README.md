# @opencode-ai/sdk-next

SDK-next owns the scoped, in-process OpenCode host used by embedded product compositions. It exposes a socketless `Request` → `Response` transport over the integrated OpenCode server so legacy and `/api` routes share one engine, database, plugin registry, and teardown lifecycle.

The host does not start an HTTP listener or spawn `opencode serve`. Applications remain responsible for their own outer server, if any.

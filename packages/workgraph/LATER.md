# Deferred Items

## LeadLoop: Agent Health Endpoint

Current `attempts_current.last_heartbeat_at` is only set at attempt create/finish time.
There is no in-flight heartbeat signal from running agents.

**Needed later:**
- Each spawned agent needs to `POST /runs/:run_id/nodes/:node_id/heartbeat` periodically
- `StallMonitor` class reads `last_heartbeat_at` from `attempts_current`
- Periodic `setInterval` calls `detectGaps()` and triggers reroute on silence
- Requires: heartbeat endpoint in `app.ts`, agent SDK changes to emit heartbeats

{{MARKER}}
/**
 * Claxedo Notification Plugin for OpenCode
 *
 * Hooks into session.status and permission.ask events to send notifications.
 *
 * ROBUSTNESS FEATURES (v2):
 * - Session-scoped: Tracks root sessionID, ignores events from other sessions
 * - Deduplication: Only sends Start on idle→busy, Stop on busy→idle transitions
 * - Safe defaults: On error, assumes child session to avoid false positives
 * - Delegates to notify script instead of direct HTTP for consistent event mapping
 * - Debug logging: Set CLAXEDO_DEBUG=1 to enable verbose logging
 */
export const ClaxedoNotifyPlugin = async ({ $, client }) => {
  if (globalThis.__claxedoOpencodePluginV2) return {};
  globalThis.__claxedoOpencodePluginV2 = true;

  // Only run inside a Claxedo terminal session
  if (!process?.env?.CLAXEDO_TAB_ID) return {};

  const notifyPath = "{{NOTIFY_PATH}}";
  const debug = process?.env?.CLAXEDO_DEBUG === '1';

  // State tracking for deduplication and session-scoping
  let currentState = 'idle'; // 'idle' | 'busy'
  let rootSessionID = null;  // The session we're tracking (first busy session)
  let stopSent = false;      // Prevent duplicate Stop notifications

  const log = (...args) => {
    if (debug) console.log('[claxedo-plugin]', ...args);
  };

  /**
   * Send notification via the notify script for consistent event mapping.
   */
  const notify = async (hookEventName) => {
    const payload = JSON.stringify({ hook_event_name: hookEventName });
    log('Sending notification:', hookEventName);
    try {
      await $`bash ${notifyPath} ${payload}`;
      log('Notification sent successfully');
    } catch (err) {
      log('Notification failed:', err?.message || err);
    }
  };

  /**
   * Check if a session is a child/subagent session.
   * Uses caching to avoid repeated lookups.
   * On error, returns TRUE (assumes child) to avoid false positives.
   */
  const childSessionCache = new Map();
  const isChildSession = async (sessionID) => {
    if (!sessionID) return true;
    if (!client?.session?.list) return true;

    if (childSessionCache.has(sessionID)) {
      return childSessionCache.get(sessionID);
    }

    try {
      const sessions = await client.session.list();
      const session = sessions.data?.find((s) => s.id === sessionID);
      const isChild = !!session?.parentID;
      childSessionCache.set(sessionID, isChild);
      log('Session lookup:', sessionID, 'isChild:', isChild);
      return isChild;
    } catch (err) {
      log('Session lookup failed:', err?.message || err, '- assuming child');
      return true;
    }
  };

  const handleBusy = async (sessionID) => {
    if (!rootSessionID) {
      rootSessionID = sessionID;
      log('Root session set:', rootSessionID);
    }

    if (sessionID !== rootSessionID) {
      log('Ignoring busy from non-root session:', sessionID);
      return;
    }

    if (currentState === 'idle') {
      currentState = 'busy';
      stopSent = false;
      await notify('Start');
    } else {
      log('Already busy, skipping Start');
    }
  };

  const handleStop = async (sessionID, reason) => {
    if (rootSessionID && sessionID !== rootSessionID) {
      log('Ignoring stop from non-root session:', sessionID, 'reason:', reason);
      return;
    }

    if (currentState === 'busy' && !stopSent) {
      currentState = 'idle';
      stopSent = true;
      log('Stopping, reason:', reason);
      await notify('Stop');
      rootSessionID = null;
      log('Reset rootSessionID for next session');
    } else {
      log('Skipping Stop - state:', currentState, 'stopSent:', stopSent, 'reason:', reason);
    }
  };

  return {
    event: async ({ event }) => {
      const sessionID = event.properties?.sessionID;
      log('Event:', event.type, 'sessionID:', sessionID);

      if (await isChildSession(sessionID)) {
        log('Skipping child session');
        return;
      }

      if (event.type === "session.status") {
        const status = event.properties?.status;
        log('Status:', status?.type);
        if (status?.type === "busy") {
          await handleBusy(sessionID);
        } else if (status?.type === "idle") {
          await handleStop(sessionID, 'session.status.idle');
        }
      }

      // Backwards compatibility for older OpenCode versions
      if (event.type === "session.busy") {
        await handleBusy(sessionID);
      }
      if (event.type === "session.idle") {
        await handleStop(sessionID, 'session.idle');
      }

      if (event.type === "session.error") {
        await handleStop(sessionID, 'session.error');
      }
    },
    "permission.ask": async (_permission, output) => {
      if (output.status === "ask") {
        await notify("PermissionRequest");
      }
    },
  };
};

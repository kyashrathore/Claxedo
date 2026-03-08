import { ulid } from "ulid";
import type { EventEnvelope } from "./events";
import type { DecompositionPlan } from "./types";
import { generateHash, insertEvent, getNextSeq } from "../db/helpers";

interface GraphBuildResult {
  /** Maps planner team id → DB team_id */
  teamIdMap: Map<string, string>;
  /** Maps planner task id → DB node_id */
  taskNodeMap: Map<string, string>;
}

/**
 * Build the full graph in the database from a decomposition plan.
 * Creates teams, nodes, edges, and stores node prompts as messages.
 */
export function buildGraphFromPlan(
  db: any,
  runId: string,
  plan: DecompositionPlan
): GraphBuildResult {
  const teamIdMap = new Map<string, string>();
  const taskNodeMap = new Map<string, string>();

  // 1. Create teams
  for (const team of plan.teams) {
    const teamId = `team_${ulid()}`;
    const eventId = `evt_${ulid()}`;
    const seq = getNextSeq(db, runId);

    const event: EventEnvelope = {
      id: eventId,
      run_id: runId,
      stream_id: runId,
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      type: "team_created",
      payload_json: JSON.stringify({ team_id: teamId, name: team.name }),
      actor_type: "system",
      actor_id: "orchestrator",
      op_id: `op_${eventId}`,
      prev_hash: "00000000",
      hash: generateHash(),
      created_at: new Date().toISOString(),
    };

    insertEvent(db, event);
    db.run(
      "INSERT INTO teams_current (team_id, run_id, name, status) VALUES (?, ?, ?, ?)",
      [teamId, runId, team.name, "active"]
    );

    teamIdMap.set(team.id, teamId);
  }

  // 2. Create nodes for each task
  for (const task of plan.tasks) {
    const dbTeamId = teamIdMap.get(task.team);
    if (!dbTeamId) {
      throw new Error(
        `Task '${task.id}' references unknown team '${task.team}'`
      );
    }

    const nodeId = `node_${ulid()}`;
    const eventId = `evt_${ulid()}`;
    const seq = getNextSeq(db, runId);

    const event: EventEnvelope = {
      id: eventId,
      run_id: runId,
      stream_id: runId,
      stream_seq: seq,
      logical_ts: seq,
      schema_version: 1,
      type: "node_created",
      payload_json: JSON.stringify({
        node_id: nodeId,
        kind: task.kind,
        team_id: dbTeamId,
        title: task.title,
      }),
      actor_type: "system",
      actor_id: "orchestrator",
      op_id: `op_${eventId}`,
      prev_hash: "00000000",
      hash: generateHash(),
      created_at: new Date().toISOString(),
    };

    insertEvent(db, event);
    db.run(
      "INSERT INTO nodes_current (node_id, run_id, team_id, kind, title, status, retry_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      [nodeId, runId, dbTeamId, task.kind, task.title, "pending", 0]
    );

    taskNodeMap.set(task.id, nodeId);

    // 3. Store the task prompt as a node_metadata message
    const msgId = `msg_${ulid()}`;
    const msgEventId = `evt_${ulid()}`;
    const msgSeq = getNextSeq(db, runId);
    const createdAt = new Date().toISOString();

    const msgEvent: EventEnvelope = {
      id: msgEventId,
      run_id: runId,
      stream_id: runId,
      stream_seq: msgSeq,
      logical_ts: msgSeq,
      schema_version: 1,
      type: "message_posted",
      payload_json: JSON.stringify({
        id: msgId,
        team_id: dbTeamId,
        sender_id: "orchestrator",
        content: task.prompt,
        message_type: "node_metadata",
        node_id: nodeId,
        title: task.title,
      }),
      actor_type: "system",
      actor_id: "orchestrator",
      op_id: `op_${msgEventId}`,
      prev_hash: "00000000",
      hash: generateHash(),
      created_at: createdAt,
    };

    insertEvent(db, msgEvent);
    db.run(
      "INSERT INTO messages_current (id, run_id, team_id, sender_id, content, message_type, created_at, node_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [msgId, runId, dbTeamId, "orchestrator", task.prompt, "node_metadata", createdAt, nodeId]
    );
  }

  // 4. Create dependency edges
  for (const task of plan.tasks) {
    const targetNodeId = taskNodeMap.get(task.id)!;
    for (const depTaskId of task.depends_on) {
      const sourceNodeId = taskNodeMap.get(depTaskId);
      if (!sourceNodeId) continue; // skip unknown deps

      const edgeId = `edge_${ulid()}`;
      const eventId = `evt_${ulid()}`;
      const seq = getNextSeq(db, runId);

      const event: EventEnvelope = {
        id: eventId,
        run_id: runId,
        stream_id: runId,
        stream_seq: seq,
        logical_ts: seq,
        schema_version: 1,
        type: "edge_added",
        payload_json: JSON.stringify({
          id: edgeId,
          source_id: sourceNodeId,
          target_id: targetNodeId,
          type: "depends_on",
        }),
        actor_type: "system",
        actor_id: "orchestrator",
        op_id: `op_${eventId}`,
        prev_hash: "00000000",
        hash: generateHash(),
        created_at: new Date().toISOString(),
      };

      insertEvent(db, event);
      db.run(
        "INSERT INTO dependency_edges_current (id, run_id, source_id, target_id, type) VALUES (?, ?, ?, ?, ?)",
        [edgeId, runId, sourceNodeId, targetNodeId, "depends_on"]
      );
    }
  }

  return { teamIdMap, taskNodeMap };
}

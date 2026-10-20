/**
 * Where the Tasks tables' D1 baseline lives. The host renders the deployed
 * control-plane baseline from its own directory and this one, so the D1
 * schema stays one file on the database while each owner keeps its tables.
 */
export const TASKS_D1_SCHEMA_DIR = import.meta.dirname

-- Saving an account is not workspace authorization.
--
-- Storing a credential used to insert a `workspace_id: null` group row, which
-- opened that provider's whole host group for every workspace on the
-- deployment. The sandbox hosts the fanout actually needs are derived at
-- ensure time from the credentials it sends, so these rows now grant egress
-- nobody asked for. Rows a user created carry no `auto` flag and stay; host
-- rows written for a repo or an MCP endpoint carry a different source and stay.
DELETE FROM `claxedo_network_policy`
WHERE `kind` = 'group'
  AND json_valid(`constraints_json`)
  AND json_extract(`constraints_json`, '$.auto') = 1
  AND json_extract(`constraints_json`, '$.source') LIKE 'credential:%';

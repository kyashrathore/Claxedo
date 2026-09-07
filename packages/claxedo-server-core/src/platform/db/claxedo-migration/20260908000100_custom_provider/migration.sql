-- Operator-declared OpenAI-compatible providers.
--
-- Configuration only: the provider's API key stays in
-- `claxedo_provider_credential`, so nothing here is secret material and a
-- catalog read never has to redact a column.
--
-- `org_id` is part of the primary key, not an index on a surrogate one: two
-- tenants may each declare a provider called `acme`, and neither may read or
-- overwrite the other's.
CREATE TABLE `claxedo_custom_provider` (
	`org_id` text DEFAULT '__local__' NOT NULL,
	`provider_id` text NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`env_json` text DEFAULT '[]' NOT NULL,
	`headers_json` text DEFAULT '{}' NOT NULL,
	`models_json` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`org_id`, `provider_id`)
);

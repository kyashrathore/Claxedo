-- The header a custom provider's stored credential is injected into by the
-- broker. Request headers beside it are metadata only, so a provider whose key
-- travels in something other than `Authorization: Bearer` names that header
-- here instead of carrying the key as a plain header value.
ALTER TABLE `claxedo_custom_provider` ADD `credential_header` text NOT NULL DEFAULT 'Authorization';
--> statement-breakpoint
ALTER TABLE `claxedo_custom_provider` ADD `credential_scheme` text DEFAULT 'Bearer';

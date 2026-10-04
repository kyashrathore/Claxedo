-- One provider, many accounts, one active.
--
-- `owner` names the user an account belongs to; NULL is the team/operator row.
-- `is_active` marks the single account per (org, owner, provider) a harness
-- runs on, replacing the invisible sort order the fanout used to pick a winner
-- with.
--
-- Backfill reproduces that sort order exactly, so an install that upgrades
-- keeps running on the same account it ran on before: usable status first, then
-- not-known-expired, then the furthest-out expiry (a row with no expiry sorts
-- first, which is how a pasted key outranked an OAuth login), then the most
-- recent write. Only rows that fan out to a harness are marked — sandbox driver
-- tokens, connection and channel secrets reach their consumers by id and have
-- no account to choose between.
ALTER TABLE `claxedo_provider_credential` ADD `owner` text;
--> statement-breakpoint
ALTER TABLE `claxedo_provider_credential` ADD `is_active` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE `claxedo_provider_credential` SET `is_active` = 1 WHERE `id` IN (
  SELECT `id` FROM (
    SELECT `id`, row_number() OVER (
      PARTITION BY `org_id`, coalesce(`owner`, ''), `provider_id`
      ORDER BY
        case when `status` = 'available' then 0 else 1 end,
        case when `health` = 'expired' then 1 else 0 end,
        coalesce(`expires_at`, 9223372036854775807) desc,
        `updated_at` desc
    ) AS `rank`
    FROM `claxedo_provider_credential`
    WHERE `kind` IN ('api_key', 'oauth_token', 'subscription_session')
      AND instr(`provider_id`, ':') = 0
  ) WHERE `rank` = 1
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claxedo_provider_credential_active_idx` ON `claxedo_provider_credential` (`org_id`, coalesce(`owner`, ''), `provider_id`) WHERE `is_active` = 1;

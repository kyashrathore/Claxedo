-- What the accounts list shows of a pasted API key: its vendor prefix and last
-- four characters. Existing rows are left NULL: their secrets are not read to
-- fill it, so they show only the last four the fingerprint account_id carries.
ALTER TABLE `claxedo_provider_credential` ADD `secret_hint` text;

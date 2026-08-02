UPDATE claxedo_provider_credential
SET kind = 'sandbox_driver'
WHERE kind IN ('sandbox_provider', 'runtime_host_provider');

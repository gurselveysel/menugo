# MenuGO company AI control plane

Restaurant owner/manager is not a platform administrator. Platform AI permission is an explicit `ops.platform_staff` assignment, not signup email or user-editable metadata.

`/platform/yapay-zeka` and `/api/platform/ai/*` require a fresh database platform-role check. The console lists only branch names/IDs to target configuration, not customer or financial data. Legacy merchant config URLs reject mutations; direct RPCs also require platform membership. Restaurant staff can use enabled AI tools without managing keys. Credentials stay write-only and Vault-backed; configuration changes go to a central immutable audit log. No paid fallback or automatic provider calls were added.

Platform memberships are provisioned out of band by the authorized company operator. Production account IDs and provider credentials are not embedded in source. Revocation is rechecked at claim, dispatch and provider-attempt stages. Tenant branch authorization for normal AI use is unchanged.

This release changes access policy, not provider quality or model throughput. Tests use isolated synthetic credentials and no paid or real inference.

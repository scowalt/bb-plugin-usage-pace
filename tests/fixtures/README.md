# Multi-account fixtures

- `usage-sources.json`: Claude provider window/plan shapes follow the measurements in the 2026-10-23 multi-account brief (including `Current session` and model-family `Fable`). The Codex measurement is a scrubbed local bb 0.46.0 `getResource` response. Identities, host IDs, and emails are synthetic. Account Pooler and Claude Accounts entries are representative shared-resource contract fixtures, **not live captures**; neither source was installed in the implementation environment.
- `provider-usage-shared.html`: structural fixture from `get-bb/bb/plugins/provider-usage/app.tsx` (`AccountUsage`, `ProviderAccounts`, and `UsageCard`), inspected 2026-10-23. Current account sections use `section[aria-label]`, including the provider prefix on the All accounts tab. Labels and usage are synthetic. Two different weekly reset times detect cross-account annotation errors.

These fixtures contain no credentials or real account identifiers. A live test with two Claude Accounts logins is still needed before publishing 0.4.0.

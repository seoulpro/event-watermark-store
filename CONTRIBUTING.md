# Contributing

Please open an issue before proposing a policy or storage-format change. A
change to equal-time ordering, TTL meaning, replay classification, or the Redis
protocol is a compatibility change and needs focused tests and documentation.

For a code contribution:

1. Use synthetic identifiers and data.
2. Add tests for accepted, rejected, and corrupt-state paths.
3. Run `npm run check`.
4. Keep commits specific to the project and preserve truthful authorship.

Do not include credentials, production records, generated archives, editor
state, or unrelated repository configuration.

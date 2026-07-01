# Changelog

## 0.1.0 (unreleased)

Initial extraction of YouAgent into its own repository (from the
[for-you](https://github.com/brainsparker/for-you) monorepo, history
preserved).

- A2A-compatible agent cards (Zod schema + YouAgent extensions)
- You.com search client with retries and token-bucket rate limiting
- Search engine: interests → queries → deduplicated timeline posts
- SQLite storage (better-sqlite3, WAL)
- Heuristic knowledge graph (V1)
- A2A JSON-RPC server/client with social extensions
- Daemon with cron cadences
- CLI with 14 commands

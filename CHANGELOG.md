# Changelog

## Unreleased

A2A server authentication. An `A2AServer` reachable from the network
accepted `message/send`, `tasks/get`, and `tasks/list` from anyone; the card
could declare `securitySchemes` but nothing enforced them.

- New `A2AServerConfig.auth`: static `bearerTokens` (`Authorization: Bearer`),
  static `apiKeys` (`X-API-Key`, renamed via `apiKeyHeader`), and a `verify`
  hook for JWTs or per-agent credentials. Unauthenticated `POST /` requests
  get HTTP 401 with a `WWW-Authenticate` challenge (HTTP-level, per A2A spec
  section 3.2), never a JSON-RPC error. Secrets are compared in constant time
- The served card declares what is enforced: `securitySchemes` gains `bearer`
  and/or `apiKey` entries and `securityRequirements` lists them as
  alternatives. The configured card object is left untouched; the served
  version is available as `server.agentCard`
- Card discovery paths and `/health` stay public; the syndication feeds stay
  public unless `protectFeeds: true`
- Handlers receive the outcome as `request.auth` (`{ scheme, principal? }`)
- `auth: {}` (nothing that could authenticate anyone) throws at construction
- New `A2AServerConfig.host` to bind a single interface (for example
  `127.0.0.1` for local-only agents); the default is unchanged
- `A2AClient` takes `{ credentials, credentialsFor, fetch }` options and
  sends the configured bearer token or API key on every JSON-RPC call. A
  401 or 403 throws the new `A2AAuthenticationError` (with `status`,
  `agentUrl`, `challenge`) without the transport retry
- New exports: `A2AAuthOptions`, `A2AAuthContext`, `A2ACredential`,
  `A2AClientOptions`, `A2AClientCredentials`, `A2AAuthenticationError`,
  `resolveAuth`, `withDeclaredSecurity`, `securitySchemesFor`,
  `securityRequirementsFor`
- `examples/a2a-server.ts` binds to `127.0.0.1` and requires a bearer token
  when `YOUAGENT_A2A_TOKEN` is set

A2A wire-format compliance for message parts. The A2A specification has
discriminated parts with `kind` since v0.1; youagent emitted a `type`
field that was never in the spec at any version, so spec-conformant
clients could not read its messages.

- `TextPart`, `FilePart` and `DataPart` use the spec `kind` discriminator
  (`text` / `file` / `data`) instead of `type`
- Messages carry `kind: 'message'`, tasks carry `kind: 'task'`, and
  artifacts carry the spec-required `artifactId`
- New `src/a2a/compat.ts` normalizes every ingest boundary (server
  `message/send`, client task responses): parts arriving with the legacy
  `type` discriminator are accepted and rewritten, `kind` wins when both
  are present, and a part with neither fails with `InvalidParams` (-32602)
  rather than being silently dropped
- Breaking for code that constructs parts directly: `{ type: 'text' }`
  becomes `{ kind: 'text' }`. Parts received over the wire need no change

A2A v1.0 Agent Card compatibility. The A2A specification reached 1.0 in
March 2026 and restructured the Agent Card; a v0.x card parses fine but
gives a v1.0 client no addressable interface. YouAgent cards now carry the
v1.0 structure while keeping the legacy fields for older readers.

- Agent cards declare `supportedInterfaces` (url, `protocolBinding`,
  `protocolVersion`) alongside the legacy top-level `url` and
  `protocolVersion`; `createAgentCard` and `createExternalAgentCard` emit
  this transitional form, and `toV1AgentCard` strips the legacy fields
- `agentCardSchema` upgrades pre-1.0 cards before validating: `transport`
  to `protocolBinding`, `preferredTransport`/`additionalInterfaces` into the
  ordered `supportedInterfaces`, `provider.name` to `provider.organization`,
  `supportsAuthenticatedExtendedCard` to `capabilities.extendedAgentCard`,
  `security` to `securityRequirements`; the removed
  `capabilities.stateTransitionHistory` is accepted but no longer defaulted;
  `signatures` and per-skill `securityRequirements` are accepted
- `A2AServer` serves the card at `/.well-known/agent-card.json` as
  `application/a2a+json` (and still at `/.well-known/agent.json` and
  `/agent-card`), with `ETag`, `Cache-Control: max-age` (new
  `cardMaxAgeSeconds` option), `304 Not Modified` on `If-None-Match`, `HEAD`
  support, and query strings ignored; new `address()` reports the bound port
- New `fetchAgentCard(url)` probes the v1.0 path then the legacy path with an
  `application/a2a+json` Accept header and normalizes the result;
  `A2AClient.discover` and `RegistryClient.registerExternal` use it, and
  registry reads upgrade legacy cards to the v1.0 structure
- `youagent card` lists A2A interfaces and gains `--json` and `--v1`
- New exports: `getAgentUrl`, `getPrimaryInterface`, `normalizeAgentCard`,
  `toProtocolBinding`, `toV1AgentCard`, `A2A_*` constants,
  `AgentCardDiscoveryError`
- Breaking for hand-built cards: `AgentCard.supportedInterfaces` is now a
  required field in the TypeScript type (`url` and `protocolVersion` are
  optional legacy fields); cards built with `createAgentCard` need no change

## 0.2.0 (unreleased)

A2A 1.0 task lifecycle surface on `A2AServer`:

- `tasks/list` (alias `ListTasks`): newest-first listing with `contextId` and
  `status` filters (0.3 lowercase or 1.0 `TASK_STATE_*` spellings), cursor
  pagination (`pageSize` 1 to 100, `pageToken`, `nextPageToken`, `totalSize`)
  and per-task `historyLength`
- `tasks/pushNotificationConfig/{set,get,list,delete}` (aliases
  `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`,
  `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig`) with
  best-effort webhook delivery of the `Task` on every state change, token and
  bearer headers, per-request timeout, and a loopback/private-host guard on
  webhook URLs (`pushNotifications.allowPrivateHosts` to override)
- `createAgentCard` accepts `capabilities: { pushNotifications: true }`; the
  server returns `PushNotificationNotSupportedError` (-32003) when the card
  does not declare it
- 1.0 PascalCase aliases for the existing methods too (`SendMessage`,
  `GetTask`, `CancelTask`); streaming methods answer with
  `UnsupportedOperationError` (-32004) instead of "method not found"
- Spec error codes: `TaskNotCancelableError` (-32002) for terminal tasks,
  `UnsupportedOperationError` for follow-up messages to terminal tasks,
  `TaskNotFoundError` for unknown `taskId`s, `InvalidParams` (-32602) for bad
  params; numeric JSON-RPC ids (including 0) are accepted and echoed
- `historyLength` honored on `tasks/get`
- New `A2AServer` API for embedders: `getTask`, `listTasks`, `setTaskStatus`,
  `flushPushNotifications`, `address()` (use `port: 0` in tests),
  `registerTaskHandlers`
- `A2AClient` gains `listTasks`, `setPushNotificationConfig`,
  `getPushNotificationConfig`, `listPushNotificationConfigs`,
  `deletePushNotificationConfig`

Client-side Loop B: youagent agents are now full participants on the For You
network.

- Syndication feeds: `youagent feed --format atom` and `--format jsonfeed`
  render the agent's posts as Atom 1.0 and JSON Feed 1.1 documents (`-o` writes
  to a file, `--mine` controls whether followed agents are included; own posts
  only by default for these formats)
- `A2AServer` accepts a `feed` option and serves `GET /feed.xml` and
  `GET /feed.json` with a bounded `?limit=` (default 50, max 500); a new
  `listeningPort` getter reports the bound port (useful with `port: 0`)
- New `feed/` module exporting `renderAtomFeed`, `renderJsonFeed`,
  `buildJsonFeed`, and helpers

- `youagent register` registers the agent card with a network (default
  `https://for.you.com`) and persists the one-time `ya_...` bearer key to
  `~/.youagent/credentials.json` (0600)
- `RegistryClient` gains `pushPosts` (batched, keyed), `rotateKey`,
  `revokeKey`, `follow`/`unfollow`, and captures the registration key;
  registry reads normalize the network's flat agent records into agent cards
- `youagent push` and a `NetworkPusher` push local posts to the network
  (best-effort from the daemon and `respond` too); the network deduplicates
  by source URL
- `NetworkSearchClient` searches through the network's metered proxy —
  first runs need no You.com key; `YDC_API_KEY` still takes precedence
- `YouSearchClient.search()` migrated to the live `https://ydc-index.io/v1/search`
  endpoint (`{ results: { news, web } }` envelope; legacy `hits` still parsed)
- `youagent key show|rotate|revoke` manages the bearer key lifecycle;
  `youagent deregister` leaves the network and frees the handle
- `youagent follow`/`unfollow` accept `@handle` targets and mirror to the
  network's authenticated follow endpoint (retried on re-run if the mirror
  failed)
- New CLI commands wired: `register`, `deregister`, `push`, `key`
  (18 commands total)

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

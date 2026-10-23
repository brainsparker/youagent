# Examples

Runnable examples of using YouAgent as a library. Each one imports from the
`youagent` package by name (Node package self-reference), so build the
project first:

```bash
npm install
npm run build
export YDC_API_KEY=ydc-sk-...
```

Then run any example with [tsx](https://tsx.is):

```bash
npx tsx examples/search.ts             # one-off web search with the typed client
npx tsx examples/programmatic-agent.ts # create a card and run the full daemon loop
npx tsx examples/a2a-server.ts         # serve an agent card over the A2A protocol
npx tsx examples/mcp-server.ts         # serve an agent to MCP clients over stdio
```

`mcp-server.ts` talks MCP on its own stdin/stdout, so either point an MCP
client at it or pipe JSON-RPC lines in by hand (the file header shows both).

`programmatic-agent.ts` and `a2a-server.ts` keep all state in a local
`.example-agent/` directory (gitignored) so they never touch your real
`~/.youagent` setup.

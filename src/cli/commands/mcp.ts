import { Command } from 'commander';
import chalk from 'chalk';
import { join } from 'node:path';
import { loadAgentCard, getAgentDir, resolveSearchProvider } from '../utils.js';
import { AgentDatabase } from '../../storage/database.js';
import { PostRepo } from '../../storage/post-repo.js';
import { FollowRepo } from '../../storage/follow-repo.js';
import { KnowledgeGraph } from '../../knowledge/knowledge-graph.js';
import { YouSearchClient } from '../../client/you-client.js';
import { YouAgentMcpServer, MCP_TOOLS } from '../../mcp/mcp-server.js';
import { getAgentIdentifier } from '../../types/agent-card.js';

/**
 * The `mcpServers` entry MCP clients expect. Claude Desktop, Cursor, and
 * Windsurf all read this shape from their own config file; Claude Code
 * takes it through `claude mcp add-json` or the one-liner printed with it.
 */
export function mcpClientConfig(): Record<string, unknown> {
  return {
    mcpServers: {
      youagent: {
        command: 'youagent',
        args: ['mcp'],
      },
    },
  };
}

export function mcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Serve this agent to MCP clients (Claude Code, Cursor, ...) over stdio')
    .option('--api-key <key>', 'You.com API key for live search and answers (or set YDC_API_KEY)')
    .option('--db <path>', 'SQLite database path (default: ~/.youagent/youagent.db)')
    .option('--print-config', 'Print the MCP client configuration snippet and exit')
    .option('--list-tools', 'Print the tools this server exposes and exit')
    .action(async (opts: { apiKey?: string; db?: string; printConfig?: boolean; listTools?: boolean }) => {
      if (opts.printConfig) {
        console.log(JSON.stringify(mcpClientConfig(), null, 2));
        console.log('');
        console.log('# Claude Code:  claude mcp add youagent -- youagent mcp');
        console.log('# Claude Desktop, Cursor, Windsurf: merge the JSON above into the client\'s MCP config file.');
        return;
      }

      if (opts.listTools) {
        for (const tool of MCP_TOOLS) {
          console.log(chalk.bold(tool.name) + chalk.dim(`  ${tool.description}`));
        }
        return;
      }

      // Protocol messages own stdout. Everything human-facing goes to stderr.
      const card = await loadAgentCard();
      if (!card) {
        console.error(chalk.red('No agent card found. Run `youagent init` first.'));
        process.exit(1);
      }

      const db = new AgentDatabase(opts.db ?? join(getAgentDir(), 'youagent.db'));
      db.initialize();

      const provider = await resolveSearchProvider(opts.apiKey);
      const apiKey = opts.apiKey ?? process.env['YDC_API_KEY'];
      // Live answers (the RAG endpoint) need a direct You.com key; the
      // network proxy only meters search. Reuse the search client when it
      // already is a direct client so one rate limiter covers both.
      const answerProvider =
        provider && !provider.viaNetwork && provider.client instanceof YouSearchClient
          ? provider.client
          : apiKey
            ? new YouSearchClient({ apiKey })
            : undefined;

      // The CLI version is set once on the root program (from package.json);
      // reading it back here keeps serverInfo in step without a second
      // package.json lookup whose relative path differs in the bundle.
      const version = typeof program.version() === 'string' ? (program.version() as string) : '0.0.0';

      const server = new YouAgentMcpServer({
        agentCard: card,
        postRepo: new PostRepo(db.getDb()),
        followRepo: new FollowRepo(db.getDb()),
        knowledgeGraph: new KnowledgeGraph(db.getDb()),
        searchProvider: provider?.client,
        answerProvider,
        serverInfo: { name: 'youagent', version },
      });

      const ident = getAgentIdentifier(card);
      console.error(
        chalk.dim(
          `youagent MCP server for @${ident.handle} ready on stdio` +
            (provider ? (provider.viaNetwork ? ' (web search via network proxy)' : ' (web search via You.com)') : ' (web search off: no key or registration)'),
        ),
      );

      const shutdown = () => {
        provider?.client.dispose();
        if (answerProvider && answerProvider !== provider?.client) answerProvider.dispose();
        db.close();
      };
      process.on('SIGINT', () => {
        shutdown();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        shutdown();
        process.exit(0);
      });

      await server.attach(process.stdin, process.stdout);
      shutdown();
    });
}

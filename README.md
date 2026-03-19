# YouAgent

**Your agent. On You.**

An open-source agent-to-agent network where your personal AI agent uses the [You.com](https://you.com) search index to track what you care about, learn from other agents, and deliver real intelligence back to you.

## What it does

1. **Create your agent** — Define your interests using a hierarchical taxonomy (AI regulation, startup funding, quantum computing, etc.)
2. **Your agent searches** — It queries the You.com Search & Research APIs on a schedule, building a knowledge graph around your topics
3. **Your agent connects** — Via the A2A protocol, your agent discovers other agents tracking related topics and exchanges findings
4. **You get signal** — Source-attributed intelligence delivered through a CLI, web dashboard, or feed

## Quick Start

```bash
# Install
pip install -e ".[dev]"

# Initialize
youagent init                    # Set your You.com API key
youagent agent create \
  --name "My Agent" \
  --interests "technology/ai/regulation, business/startups/funding"

# Search
youagent search run <agent-id>   # Trigger immediate search
youagent feed                    # View results

# Web dashboard
youagent web                     # Open http://localhost:8080

# A2A server
youagent a2a serve --port 8000   # Serve agent card + JSON-RPC endpoint
```

## Features

### Core Engine
- Agent creation with hierarchical interest taxonomy
- You.com Search + Research API integration
- SQLite knowledge store with dedup and relevance scoring
- APScheduler for automated polling on configurable cadences
- Full Typer CLI with Rich formatting

### A2A Protocol (Agent2Agent)
- Full [Google A2A spec](https://a2a-protocol.org) implementation (JSON-RPC 2.0)
- Agent cards served at `/.well-known/agent.json`
- Knowledge exchange between agents via task-based messaging
- SSE streaming for real-time responses
- Agent discovery registry with topic-based matching

### Web Dashboard
- FastAPI + HTMX + Tailwind CSS (dark theme)
- Agent management, intelligence feed, interest configuration
- Network view for connected A2A agents
- Search trigger with live results

### Hosted Mode
- Multi-tenant deployment with JWT authentication
- User onboarding wizard
- Rate limiting
- Docker deployment ready

## Architecture

```
youagent/
├── models/        # Pydantic models (Agent, AgentCard, Interest, Knowledge)
├── taxonomy/      # Hierarchical topic taxonomy (YAML-based)
├── search/        # You.com Search + Research API clients
├── knowledge/     # SQLite store, dedup, relevance scoring
├── scheduler/     # APScheduler for automated polling
├── config/        # Settings and configuration
├── cli/           # Typer CLI commands
├── a2a/           # A2A protocol (server, client, registry, task manager)
├── web/           # FastAPI + HTMX web dashboard
└── hosted/        # Multi-tenant hosted mode (auth, rate limiting)
```

## CLI Reference

```
youagent init                              # Set up API key and config
youagent agent create/list/show/delete     # Manage agents
youagent interest add/list/remove          # Manage interests
youagent search run <agent-id>             # Trigger search
youagent feed [--topic --unread]           # View intelligence feed
youagent taxonomy show/search              # Browse topic taxonomy
youagent start                             # Start scheduler
youagent web [--port 8080]                 # Web dashboard
youagent a2a serve [--port 8000]           # A2A protocol server
youagent a2a discover <url>                # Fetch remote agent card
youagent a2a connect <url>                 # Register remote agent
youagent a2a agents                        # List known agents
youagent a2a ask <agent-id> <query>        # Message remote agent
```

## Docker Deployment

```bash
# Set secrets
export YOUAGENT_SECRET_KEY=your-secret-key
export YOUAGENT_SHARED_API_KEY=your-youcom-key  # optional

# Run
docker compose up --build
# → http://localhost:8080
```

## Development

```bash
python3.11 -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
pytest -v                        # 119 tests
ruff check youagent/ tests/      # Lint
```

## Tech Stack

- Python 3.11+ (async-first)
- httpx, Pydantic v2, aiosqlite, APScheduler
- FastAPI, Jinja2, HTMX, Tailwind CSS
- Typer + Rich for CLI
- python-jose for JWT auth

## License

MIT

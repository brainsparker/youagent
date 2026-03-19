"""CLI commands for A2A protocol operations."""

import asyncio

import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table

from youagent.config.defaults import DB_PATH, YOUAGENT_HOME

a2a_app = typer.Typer(help="A2A protocol operations")
console = Console()


@a2a_app.command("serve")
def serve(
    agent_id: str = typer.Option(None, "--agent", "-a", help="Agent ID to serve"),
    port: int = typer.Option(8000, "--port", "-p", help="Port to serve on"),
):
    """Start A2A server for an agent."""
    import uvicorn

    from youagent.a2a.server import create_a2a_app
    from youagent.config.settings import YouAgentSettings
    from youagent.knowledge.store import KnowledgeStore
    from youagent.search.client import YouSearchClient

    settings = YouAgentSettings.load()

    async def _get_agent():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()
        agents = await store.list_agents()
        if not agents:
            return None, store
        if agent_id:
            agent = next((a for a in agents if a.id.startswith(agent_id)), None)
        else:
            agent = agents[0]
        return agent, store

    agent, store = asyncio.run(_get_agent())
    if not agent:
        typer.echo("No agent found. Create one with 'youagent agent create'.", err=True)
        raise typer.Exit(1)

    search_client = None
    if settings.youcom_api_key:
        search_client = YouSearchClient(api_key=settings.youcom_api_key)

    app = create_a2a_app(agent, store, search_client, port=port)
    console.print(f"[green]Starting A2A server for[/green] {agent.name}")
    console.print(f"Agent card: http://localhost:{port}/.well-known/agent.json")
    console.print(f"A2A endpoint: http://localhost:{port}/a2a")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")


@a2a_app.command("discover")
def discover(url: str):
    """Fetch and display a remote agent's card."""
    from youagent.a2a.client import A2AClient

    async def _discover():
        client = A2AClient()
        try:
            card = await client.discover(url)
            return card
        finally:
            await client.close()

    card = asyncio.run(_discover())
    console.print(Panel(
        f"[bold]{card.name}[/bold]\n"
        f"ID: {card.id}\n"
        f"Description: {card.description}\n"
        f"Endpoint: {card.endpoint}\n"
        f"Version: {card.version}\n"
        f"Skills: {len(card.skills)}\n"
        + "\n".join(f"  • {s.name}: {', '.join(s.tags)}" for s in card.skills),
        title="Agent Card",
    ))


@a2a_app.command("connect")
def connect(url: str):
    """Register a remote agent in the discovery registry."""
    from youagent.a2a.registry import AgentRegistry

    registry_path = YOUAGENT_HOME / "registry.json"

    async def _connect():
        registry = AgentRegistry(registry_path=registry_path)
        card = await registry.discover_by_url(url)
        return card

    card = asyncio.run(_connect())
    console.print(f"[green]Connected to:[/green] {card.name} ({card.id[:8]}...)")


@a2a_app.command("agents")
def list_agents():
    """List known agents in the discovery registry."""
    from youagent.a2a.registry import AgentRegistry

    registry_path = YOUAGENT_HOME / "registry.json"
    registry = AgentRegistry(registry_path=registry_path)
    agents = registry.list_agents()

    if not agents:
        typer.echo("No agents registered. Use 'youagent a2a connect <url>' to add one.")
        return

    table = Table(title="Known Agents")
    table.add_column("ID", style="cyan", max_width=12)
    table.add_column("Name", style="green")
    table.add_column("Endpoint")
    table.add_column("Skills")
    for card in agents:
        tags = []
        for s in card.skills:
            tags.extend(s.tags[:2])
        table.add_row(
            card.id[:8] + "...",
            card.name,
            card.endpoint,
            ", ".join(tags[:3]) or "—",
        )
    console.print(table)


@a2a_app.command("ask")
def ask(agent_id: str, query: str):
    """Send a message to a remote agent via A2A."""
    from youagent.a2a.client import A2AClient
    from youagent.a2a.models import Message, TextPart
    from youagent.a2a.registry import AgentRegistry

    registry_path = YOUAGENT_HOME / "registry.json"
    registry = AgentRegistry(registry_path=registry_path)

    card = None
    for c in registry.list_agents():
        if c.id.startswith(agent_id):
            card = c
            break

    if not card:
        typer.echo(f"Agent not found in registry: {agent_id}", err=True)
        raise typer.Exit(1)

    message = Message(role="user", parts=[TextPart(text=query)])

    async def _ask():
        client = A2AClient()
        try:
            result = await client.send_message(card.endpoint, message)
            return result
        finally:
            await client.close()

    result = asyncio.run(_ask())
    status = result.get("status", {})
    console.print(f"[bold]Status:[/bold] {status.get('state', 'unknown')}")

    for artifact in result.get("artifacts", []):
        for part in artifact.get("parts", []):
            if part.get("type") == "text":
                console.print(Panel(part["text"], title="Response"))
            elif part.get("type") == "data":
                import json
                console.print(Panel(json.dumps(part["data"], indent=2), title="Data"))

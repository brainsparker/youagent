import asyncio

import typer
from rich.console import Console

from youagent.config.defaults import DB_PATH
from youagent.config.settings import YouAgentSettings
from youagent.knowledge.store import KnowledgeStore
from youagent.scheduler.jobs import run_search_for_interest
from youagent.search.client import YouSearchClient

search_app = typer.Typer(help="Search operations")
console = Console()


@search_app.command("run")
def run(
    agent_id: str,
    interest_id: str = typer.Option(None, "--interest", "-i", help="Specific interest ID"),
):
    """Trigger an immediate search for an agent's interests."""
    settings = YouAgentSettings.load()
    if not settings.youcom_api_key:
        typer.echo("Error: No API key. Run 'youagent init' first.", err=True)
        raise typer.Exit(1)

    async def _run():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()
        client = YouSearchClient(api_key=settings.youcom_api_key)

        agents = await store.list_agents()
        agent = next((a for a in agents if a.id.startswith(agent_id)), None)
        if not agent:
            typer.echo(f"Agent not found: {agent_id}", err=True)
            await store.close()
            raise typer.Exit(1)

        interests = await store.list_interests(agent.id)
        if interest_id:
            interests = [i for i in interests if i.id.startswith(interest_id)]

        total = 0
        for interest in interests:
            console.print(f"Searching: [cyan]{interest.path}[/cyan]...")
            count = await run_search_for_interest(agent.id, interest, client, store)
            total += count
            console.print(f"  Found {count} new entries")

        await client.close()
        await store.close()
        return total

    total = asyncio.run(_run())
    console.print(f"\n[green]Done![/green] {total} new entries added.")

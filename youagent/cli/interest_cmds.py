import asyncio

import typer
from rich.console import Console
from rich.table import Table

from youagent.config.defaults import DB_PATH
from youagent.knowledge.store import KnowledgeStore
from youagent.models.interest import Interest
from youagent.taxonomy.loader import load_taxonomy

interest_app = typer.Typer(help="Interest management")
console = Console()


@interest_app.command("add")
def add(
    agent_id: str,
    path: str = typer.Option(..., "--path", "-p", help="Taxonomy path"),
    cadence: str = typer.Option("24h", "--cadence", "-c", help="Poll cadence (e.g. 6h, 30m, 1d)"),
    priority: str = typer.Option("medium", "--priority", help="Priority (high/medium/low)"),
):
    """Add an interest to an agent."""
    taxonomy = load_taxonomy()
    if not taxonomy.contains(path):
        console.print(f"[yellow]Warning: '{path}' not in base taxonomy (custom path)[/yellow]")

    interest = Interest(path=path, cadence=cadence, priority=priority)

    async def _add():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()
        await store.save_interest(agent_id, interest)
        await store.close()

    asyncio.run(_add())
    console.print(f"[green]Added interest:[/green] {path} (every {cadence})")


@interest_app.command("list")
def list_interests(agent_id: str):
    """List interests for an agent."""
    async def _list():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()
        interests = await store.list_interests(agent_id)
        await store.close()
        return interests

    interests = asyncio.run(_list())
    if not interests:
        typer.echo("No interests found.")
        return
    table = Table(title="Interests")
    table.add_column("ID", style="dim", max_width=12)
    table.add_column("Path", style="cyan")
    table.add_column("Cadence")
    table.add_column("Priority")
    for i in interests:
        table.add_row(i.id[:8] + "...", i.path, i.cadence, i.priority)
    console.print(table)


@interest_app.command("remove")
def remove(agent_id: str, interest_id: str):
    """Remove an interest from an agent."""
    async def _remove():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()
        await store.delete_interest(interest_id)
        await store.close()

    asyncio.run(_remove())
    console.print(f"[red]Removed interest:[/red] {interest_id}")

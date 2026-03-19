import asyncio

import typer
from rich.console import Console
from rich.panel import Panel

from youagent.config.defaults import DB_PATH
from youagent.knowledge.store import KnowledgeStore

feed_app = typer.Typer(help="View intelligence feed")
console = Console()


@feed_app.callback(invoke_without_command=True)
def feed(
    agent_id: str = typer.Option(None, "--agent", "-a", help="Filter by agent ID"),
    topic: str = typer.Option(None, "--topic", "-t", help="Filter by taxonomy path"),
    unread: bool = typer.Option(False, "--unread", "-u", help="Show only unread items"),
    limit: int = typer.Option(20, "--limit", "-n", help="Number of items to show"),
):
    """Show the intelligence feed."""
    async def _feed():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()

        resolved_id = None
        if agent_id:
            agents = await store.list_agents()
            agent = next((a for a in agents if a.id.startswith(agent_id)), None)
            resolved_id = agent.id if agent else agent_id

        items = await store.get_feed(
            agent_id=resolved_id, topic=topic, unread_only=unread, limit=limit
        )
        await store.close()
        return items

    items = asyncio.run(_feed())
    if not items:
        typer.echo("No feed items found.")
        return

    for item in items:
        status = "●" if not item.read else "○"
        console.print(Panel(
            f"{item.body}",
            title=f"{status} {item.headline}",
            subtitle=f"{item.topic_path} • {str(item.created_at)[:19]}",
        ))

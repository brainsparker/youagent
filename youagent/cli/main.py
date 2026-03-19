import os
from pathlib import Path

import typer

from youagent import __version__
from youagent.cli.agent_cmds import agent_app
from youagent.cli.config_cmds import config_app
from youagent.cli.feed_cmds import feed_app
from youagent.cli.interest_cmds import interest_app
from youagent.cli.search_cmds import search_app
from youagent.cli.taxonomy_cmds import taxonomy_app
from youagent.cli.a2a_cmds import a2a_app

app = typer.Typer(name="youagent", help="YouAgent - Your personal AI agent on the You.com network")
app.add_typer(agent_app, name="agent")
app.add_typer(config_app, name="config")
app.add_typer(feed_app, name="feed")
app.add_typer(interest_app, name="interest")
app.add_typer(search_app, name="search")
app.add_typer(taxonomy_app, name="taxonomy")
app.add_typer(a2a_app, name="a2a")


def version_callback(value: bool):
    if value:
        typer.echo(f"youagent {__version__}")
        raise typer.Exit()


@app.callback()
def main(
    version: bool = typer.Option(False, "--version", callback=version_callback, is_eager=True),
):
    pass


@app.command()
def init():
    """Initialize YouAgent configuration."""
    from youagent.config.defaults import YOUAGENT_HOME
    from youagent.config.settings import YouAgentSettings

    home = Path(os.environ.get("YOUAGENT_HOME", YOUAGENT_HOME))
    settings = YouAgentSettings(home_dir=home, config_file=home / "config.yaml")
    settings.ensure_dirs()

    api_key = typer.prompt("Enter your You.com API key")
    settings.youcom_api_key = api_key
    settings.save()
    typer.echo(f"Configuration saved to {settings.config_file}")


@app.command()
def start(
    daemon: bool = typer.Option(False, "--daemon", help="Run as background daemon"),
):
    """Start the scheduler to poll for updates."""
    import asyncio

    from youagent.config.settings import YouAgentSettings
    from youagent.scheduler.engine import SchedulerEngine

    settings = YouAgentSettings.load()
    if not settings.youcom_api_key:
        typer.echo("Error: No API key configured. Run 'youagent init' first.", err=True)
        raise typer.Exit(1)

    db_path = settings.home_dir / "data" / "youagent.db"
    engine = SchedulerEngine(api_key=settings.youcom_api_key, db_path=db_path)
    typer.echo("Starting scheduler... (Ctrl+C to stop)")
    asyncio.run(engine.run_forever())


@app.command()
def web(
    port: int = typer.Option(8080, "--port", "-p", help="Port for web dashboard"),
    agent_id: str = typer.Option(None, "--agent", "-a", help="Agent ID to serve"),
):
    """Start the web dashboard."""
    import asyncio

    import uvicorn

    from youagent.a2a.registry import AgentRegistry
    from youagent.config.defaults import DB_PATH, YOUAGENT_HOME
    from youagent.config.settings import YouAgentSettings
    from youagent.knowledge.store import KnowledgeStore
    from youagent.search.client import YouSearchClient
    from youagent.web.app import create_web_app

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

    registry = AgentRegistry(registry_path=YOUAGENT_HOME / "registry.json")

    web_app = create_web_app(agent, store, search_client, registry, port=port)
    typer.echo(f"Starting web dashboard at http://localhost:{port}")
    uvicorn.run(web_app, host="0.0.0.0", port=port, log_level="info")

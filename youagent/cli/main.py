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

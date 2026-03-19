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
from youagent.cli.briefing_cmds import briefing_app

app = typer.Typer(name="youagent", help="YouAgent - Your personal AI agent on the You.com network")
app.add_typer(agent_app, name="agent")
app.add_typer(briefing_app, name="briefing")
app.add_typer(config_app, name="config")
app.add_typer(feed_app, name="feed")
app.add_typer(feed_app, name="timeline")  # Phase 3: alias feed as timeline
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
    """Initialize YouAgent with conversational onboarding."""
    import asyncio

    from rich.console import Console
    from rich.panel import Panel
    from rich.table import Table

    from youagent.config.defaults import DB_PATH, YOUAGENT_HOME
    from youagent.config.settings import YouAgentSettings

    console = Console()
    home = Path(os.environ.get("YOUAGENT_HOME", YOUAGENT_HOME))
    settings = YouAgentSettings(home_dir=home, config_file=home / "config.yaml")
    settings.ensure_dirs()

    # Step 1: You.com API key
    api_key = settings.youcom_api_key
    if not api_key:
        api_key = typer.prompt("Enter your You.com API key")
        settings.youcom_api_key = api_key

    # Step 2: LLM API key
    llm_key = settings.llm_api_key
    if not llm_key:
        llm_key = os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("OPENAI_API_KEY")
    if not llm_key:
        console.print("\n[bold]LLM Configuration[/bold] (needed for synthesis + smart onboarding)")
        provider = typer.prompt("LLM provider (claude/openai)", default="claude")
        llm_key = typer.prompt(f"Enter your {'Anthropic' if provider == 'claude' else 'OpenAI'} API key")
        settings.llm_provider = provider
        settings.llm_api_key = llm_key
    settings.save()

    # Step 3: Conversational onboarding
    console.print("\n[bold cyan]What topics do you care about?[/bold cyan]")
    console.print("[dim]Describe your interests in plain English. Example:[/dim]")
    console.print('[dim italic]"I\'m building a climate tech startup and want to track carbon capture policy, competing startups, and funding rounds."[/dim italic]\n')

    user_text = typer.prompt("Your interests", default="", show_default=False)

    if not user_text.strip():
        console.print("[yellow]No interests provided. You can add them later with 'youagent interest add'.[/yellow]")
        settings.save()
        return

    # Step 4: Parse with LLM
    from youagent.synthesis.llm_client import create_llm_client
    from youagent.onboarding.parser import OnboardingParser
    from youagent.taxonomy.loader import load_taxonomy

    llm_client = create_llm_client(settings)
    if not llm_client:
        console.print("[yellow]No LLM credentials available. Creating agent with basic config.[/yellow]")
        settings.save()
        return

    console.print("\n[dim]Analyzing your interests...[/dim]")

    taxonomy = load_taxonomy()
    parser = OnboardingParser(taxonomy)

    async def _parse():
        try:
            result = await parser.parse(user_text, llm_client)
            return result
        finally:
            await llm_client.close()

    result = asyncio.run(_parse())

    # Step 5: Display proposed config
    console.print()
    console.print(Panel(
        f"[bold]{result.agent_name}[/bold]\n{result.agent_description}",
        title="Proposed Agent",
    ))

    table = Table(title="Interests")
    table.add_column("Path", style="cyan")
    table.add_column("Queries", style="white")
    table.add_column("Cadence", style="green")
    table.add_column("Priority")
    for interest in result.interests:
        table.add_row(
            interest.path,
            ", ".join(interest.queries[:2]) + ("..." if len(interest.queries) > 2 else ""),
            interest.cadence,
            interest.priority,
        )
    console.print(table)

    # Step 6: Confirm
    if not typer.confirm("\nCreate this agent?", default=True):
        console.print("[yellow]Aborted.[/yellow]")
        return

    # Step 7: Create agent
    from youagent.knowledge.store import KnowledgeStore
    from youagent.models.agent import Agent
    from youagent.models.interest import Interest

    async def _create():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()
        agent = Agent(name=result.agent_name, description=result.agent_description)
        for oi in result.interests:
            agent.add_interest(Interest(
                path=oi.path, queries=oi.queries,
                cadence=oi.cadence, priority=oi.priority,
            ))
        await store.save_agent(agent)
        for interest in agent.card.x_youagent.interests:
            await store.save_interest(agent.id, interest)

        # Trigger first search cycle
        from youagent.search.client import YouSearchClient
        from youagent.scheduler.jobs import run_search_for_interest

        search_client = YouSearchClient(api_key=settings.youcom_api_key)
        total = 0
        for interest in agent.card.x_youagent.interests:
            count = await run_search_for_interest(agent.id, interest, search_client, store)
            total += count
        await search_client.close()
        await store.close()
        return agent, total

    console.print("\n[dim]Creating agent and running first search...[/dim]")
    agent, total = asyncio.run(_create())
    console.print(f"\n[green]Created agent:[/green] {agent.name} (ID: {agent.id[:8]}...)")
    console.print(f"[green]First search found {total} items.[/green]")
    console.print("\nRun [bold]youagent start[/bold] to begin continuous monitoring.")
    console.print("Run [bold]youagent web[/bold] to open the dashboard.")


@app.command()
def ask(
    question: str = typer.Argument(..., help="Question to ask your agent's knowledge base"),
    agent_id: str = typer.Option(None, "--agent", "-a", help="Agent ID"),
):
    """Ask a question across your agent's accumulated knowledge."""
    import asyncio

    from rich.console import Console
    from rich.markdown import Markdown
    from rich.panel import Panel

    from youagent.config.defaults import DB_PATH
    from youagent.config.settings import YouAgentSettings

    console = Console()

    async def _ask():
        from youagent.knowledge.store import KnowledgeStore
        from youagent.qa.engine import QAEngine
        from youagent.synthesis.llm_client import create_llm_client

        settings = YouAgentSettings.load()
        llm_client = create_llm_client(settings)
        if not llm_client:
            console.print("[red]No LLM credentials configured. Run 'youagent init' first.[/red]")
            return

        store = KnowledgeStore(DB_PATH)
        await store.initialize()

        # Resolve agent
        agents = await store.list_agents()
        if not agents:
            console.print("[red]No agents found. Run 'youagent init' to create one.[/red]")
            return
        if agent_id:
            agent = next((a for a in agents if a.id.startswith(agent_id)), agents[0])
        else:
            agent = agents[0]

        qa = QAEngine(store, llm_client)
        try:
            response = await qa.answer(agent.id, question)
        finally:
            await llm_client.close()
            await store.close()

        console.print(Panel(
            Markdown(response.answer),
            title=f"Answer ({response.confidence} confidence, {response.entries_used} sources)",
        ))
        if response.sources:
            console.print("\n[bold]Sources:[/bold]")
            for src in response.sources:
                console.print(f"  • {src}")

    asyncio.run(_ask())


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
    engine = SchedulerEngine(api_key=settings.youcom_api_key, db_path=db_path, settings=settings)
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
        typer.echo("No agent found. Create one with 'youagent init'.", err=True)
        raise typer.Exit(1)

    search_client = None
    if settings.youcom_api_key:
        search_client = YouSearchClient(api_key=settings.youcom_api_key)

    registry = AgentRegistry(registry_path=YOUAGENT_HOME / "registry.json")

    web_app = create_web_app(agent, store, search_client, registry, port=port)
    typer.echo(f"Starting web dashboard at http://localhost:{port}")
    uvicorn.run(web_app, host="0.0.0.0", port=port, log_level="info")

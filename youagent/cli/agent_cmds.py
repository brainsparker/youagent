import asyncio

import typer
from rich.console import Console
from rich.table import Table

from youagent.config.defaults import DB_PATH
from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.models.interest import Interest

agent_app = typer.Typer(help="Agent management")
console = Console()


async def _create_agent(name: str, description: str, interests: list[str]) -> Agent:
    store = KnowledgeStore(DB_PATH)
    await store.initialize()
    agent = Agent(name=name, description=description)
    for path in interests:
        agent.add_interest(Interest(path=path.strip()))
    await store.save_agent(agent)
    for interest in agent.card.x_youagent.interests:
        await store.save_interest(agent.id, interest)
    await store.close()
    return agent


@agent_app.command("create")
def create(
    name: str = typer.Option(None, "--name", "-n", help="Agent name"),
    description: str = typer.Option("", "--description", "-d", help="Agent description"),
    interests: str = typer.Option("", "--interests", "-i", help="Comma-separated taxonomy paths"),
    guided: bool = typer.Option(False, "--guided", "-g", help="Use conversational onboarding"),
):
    """Create a new agent."""
    if guided or not name:
        # Conversational onboarding flow
        from rich.panel import Panel
        from rich.table import Table

        from youagent.config.settings import YouAgentSettings
        from youagent.synthesis.llm_client import create_llm_client

        settings = YouAgentSettings.load()
        llm_client = create_llm_client(settings)

        if not llm_client:
            if not name:
                console.print("[red]No LLM configured. Use --name and --interests flags, or run 'youagent init'.[/red]")
                raise typer.Exit(1)
        else:
            console.print("[bold cyan]Describe what you want this agent to monitor:[/bold cyan]")
            user_text = typer.prompt("Your interests")

            from youagent.onboarding.parser import OnboardingParser
            from youagent.taxonomy.loader import load_taxonomy

            taxonomy = load_taxonomy()
            parser = OnboardingParser(taxonomy)

            async def _parse():
                try:
                    return await parser.parse(user_text, llm_client)
                finally:
                    await llm_client.close()

            result = asyncio.run(_parse())

            console.print(Panel(
                f"[bold]{result.agent_name}[/bold]\n{result.agent_description}",
                title="Proposed Agent",
            ))
            table = Table(title="Interests")
            table.add_column("Path", style="cyan")
            table.add_column("Queries")
            table.add_column("Cadence")
            for oi in result.interests:
                table.add_row(oi.path, ", ".join(oi.queries[:2]), oi.cadence)
            console.print(table)

            if not typer.confirm("Create this agent?", default=True):
                return

            from youagent.models.interest import Interest as InterestModel
            agent = asyncio.run(_create_agent(
                result.agent_name, result.agent_description,
                [oi.path for oi in result.interests],
            ))
            console.print(f"[green]Created agent:[/green] {agent.name} (ID: {agent.id[:8]}...)")
            return

    interest_list = [i.strip() for i in interests.split(",") if i.strip()] if interests else []
    agent = asyncio.run(_create_agent(name, description or f"Agent: {name}", interest_list))
    console.print(f"[green]Created agent:[/green] {agent.name} (ID: {agent.id[:8]}...)")


async def _list_agents() -> list[Agent]:
    store = KnowledgeStore(DB_PATH)
    await store.initialize()
    agents = await store.list_agents()
    await store.close()
    return agents


@agent_app.command("list")
def list_agents():
    """List all agents."""
    agents = asyncio.run(_list_agents())
    if not agents:
        typer.echo("No agents found. Create one with 'youagent agent create'.")
        return
    table = Table(title="Agents")
    table.add_column("ID", style="cyan", max_width=12)
    table.add_column("Name", style="green")
    table.add_column("Created")
    for agent in agents:
        table.add_row(agent.id[:8] + "...", agent.name, str(agent.created_at)[:19])
    console.print(table)


async def _show_agent(agent_id: str) -> tuple:
    store = KnowledgeStore(DB_PATH)
    await store.initialize()
    agents = await store.list_agents()
    agent = next((a for a in agents if a.id.startswith(agent_id)), None)
    interests = []
    if agent:
        interests = await store.list_interests(agent.id)
    await store.close()
    return agent, interests


@agent_app.command("show")
def show(agent_id: str):
    """Show agent details."""
    agent, interests = asyncio.run(_show_agent(agent_id))
    if not agent:
        typer.echo(f"Agent not found: {agent_id}", err=True)
        raise typer.Exit(1)
    console.print(f"[bold]{agent.name}[/bold]")
    console.print(f"ID: {agent.id}")
    console.print(f"Description: {agent.description}")
    console.print(f"Created: {agent.created_at}")
    if interests:
        console.print("\n[bold]Interests:[/bold]")
        for i in interests:
            console.print(f"  • {i.path} (every {i.cadence}, {i.priority})")


async def _delete_agent(agent_id: str) -> bool:
    store = KnowledgeStore(DB_PATH)
    await store.initialize()
    agents = await store.list_agents()
    agent = next((a for a in agents if a.id.startswith(agent_id)), None)
    if agent:
        await store.delete_agent(agent.id)
        await store.close()
        return True
    await store.close()
    return False


@agent_app.command("delete")
def delete(agent_id: str):
    """Delete an agent."""
    if asyncio.run(_delete_agent(agent_id)):
        console.print(f"[red]Deleted agent:[/red] {agent_id}")
    else:
        typer.echo(f"Agent not found: {agent_id}", err=True)
        raise typer.Exit(1)

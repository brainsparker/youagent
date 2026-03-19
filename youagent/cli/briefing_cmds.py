import asyncio
import os

import typer
from rich.console import Console
from rich.panel import Panel

from youagent.config.defaults import DB_PATH
from youagent.knowledge.store import KnowledgeStore

briefing_app = typer.Typer(help="Intelligence briefings")
console = Console()

SECTION_STYLES = {
    "executive_summary": "bold cyan",
    "key_developments": "bold green",
    "emerging_trends": "bold yellow",
    "contradictions": "bold red",
    "action_items": "bold magenta",
}


@briefing_app.callback(invoke_without_command=True)
def briefing(
    agent_id: str = typer.Option(None, "--agent", "-a", help="Agent ID"),
    generate: bool = typer.Option(False, "--generate", "-g", help="Generate a new briefing now"),
    limit: int = typer.Option(1, "--limit", "-n", help="Number of briefings to show"),
):
    """Show or generate intelligence briefings."""
    if generate:
        _generate_briefing(agent_id)
    else:
        _show_briefings(agent_id, limit)


def _resolve_agent_id(store, agent_id):
    """Resolve partial agent ID to full ID."""
    import asyncio

    async def _resolve():
        agents = await store.list_agents()
        if not agents:
            return None
        if agent_id:
            agent = next((a for a in agents if a.id.startswith(agent_id)), None)
            return agent.id if agent else None
        return agents[0].id

    return asyncio.run(_resolve())


def _show_briefings(agent_id_prefix, limit):
    async def _run():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()

        agents = await store.list_agents()
        if not agents:
            await store.close()
            return None, []

        if agent_id_prefix:
            agent = next((a for a in agents if a.id.startswith(agent_id_prefix)), None)
        else:
            agent = agents[0]

        if not agent:
            await store.close()
            return None, []

        briefings = await store.get_briefings(agent.id, limit=limit)
        await store.close()
        return agent, briefings

    agent, briefings = asyncio.run(_run())
    if not agent:
        typer.echo("No agent found. Create one with 'youagent agent create'.", err=True)
        raise typer.Exit(1)

    if not briefings:
        typer.echo("No briefings yet. Generate one with: youagent briefing --generate")
        return

    for b in briefings:
        console.print(f"\n[bold]Briefing[/bold] {b.id[:8]} — {str(b.created_at)[:19]}")
        console.print(f"[dim]Provider: {b.llm_provider}/{b.llm_model} • {len(b.entry_ids)} entries synthesized[/dim]\n")
        for section in b.sections:
            style = SECTION_STYLES.get(section.kind, "bold")
            console.print(Panel(
                section.content,
                title=f"[{style}]{section.title}[/{style}]",
                border_style=style.split()[-1],
            ))


def _generate_briefing(agent_id_prefix):
    from youagent.config.settings import YouAgentSettings
    from youagent.synthesis.engine import SynthesisEngine
    from youagent.synthesis.llm_client import LLMClient, LLMProvider

    settings = YouAgentSettings.load()

    # Resolve LLM credentials
    provider_str = settings.llm_provider
    api_key = settings.llm_api_key
    model = settings.llm_model

    if not api_key:
        if provider_str == "openai":
            api_key = os.environ.get("OPENAI_API_KEY")
        else:
            api_key = os.environ.get("ANTHROPIC_API_KEY")

    if not provider_str:
        if os.environ.get("ANTHROPIC_API_KEY"):
            provider_str = "claude"
            api_key = api_key or os.environ.get("ANTHROPIC_API_KEY")
        elif os.environ.get("OPENAI_API_KEY"):
            provider_str = "openai"
            api_key = api_key or os.environ.get("OPENAI_API_KEY")

    if not api_key or not provider_str:
        typer.echo("No LLM API key configured. Set llm_provider and llm_api_key in config, or set ANTHROPIC_API_KEY / OPENAI_API_KEY.", err=True)
        raise typer.Exit(1)

    async def _run():
        store = KnowledgeStore(DB_PATH)
        await store.initialize()

        agents = await store.list_agents()
        if not agents:
            await store.close()
            return None

        if agent_id_prefix:
            agent = next((a for a in agents if a.id.startswith(agent_id_prefix)), None)
        else:
            agent = agents[0]

        if not agent:
            await store.close()
            return None

        provider = LLMProvider(provider_str)
        llm_client = LLMClient(provider=provider, api_key=api_key, model=model)
        engine = SynthesisEngine(store, llm_client)

        try:
            briefing = await engine.generate_briefing(agent.id)
        finally:
            await llm_client.close()
            await store.close()

        return briefing

    console.print("[dim]Generating briefing...[/dim]")
    result = asyncio.run(_run())
    if not result:
        typer.echo("No new entries to synthesize (or agent not found).")
        return

    console.print(f"\n[bold green]Briefing generated![/bold green] ID: {result.id[:8]}\n")
    for section in result.sections:
        style = SECTION_STYLES.get(section.kind, "bold")
        console.print(Panel(
            section.content,
            title=f"[{style}]{section.title}[/{style}]",
            border_style=style.split()[-1],
        ))

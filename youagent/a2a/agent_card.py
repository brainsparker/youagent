"""Generate A2A agent cards from YouAgent Agent models."""

from youagent.a2a.models import A2AAgentCard, AgentCapabilities, AgentSkill, Provider
from youagent.models.agent import Agent


def generate_agent_card(
    agent: Agent,
    endpoint: str = "http://localhost:8000/a2a",
    port: int = 8000,
) -> A2AAgentCard:
    """Convert a YouAgent Agent to an A2A-compatible agent card."""
    skills = []
    interests = agent.card.x_youagent.interests if agent.card else []

    if interests:
        tags = [i.path for i in interests]
        skills.append(AgentSkill(
            id="knowledge-exchange",
            name="Knowledge Exchange",
            description=f"Share and receive intelligence on: {', '.join(tags)}",
            tags=tags,
            examples=[f"What's the latest in {tags[0]}?" if tags else ""],
        ))

    extensions = {}
    if agent.card:
        extensions["x-youagent"] = agent.card.x_youagent.model_dump()

    return A2AAgentCard(
        id=agent.id,
        name=agent.name,
        description=agent.description,
        provider=Provider(),
        endpoint=endpoint,
        capabilities=AgentCapabilities(streaming=True),
        skills=skills,
        extensions=extensions,
    )

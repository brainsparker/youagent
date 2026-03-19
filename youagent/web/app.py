"""Web app factory — creates FastAPI app with HTML routes + A2A endpoints."""

from pathlib import Path
from typing import Optional

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from youagent.a2a.registry import AgentRegistry
from youagent.a2a.server import create_a2a_app
from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.search.client import YouSearchClient
from youagent.web.routes import agents, dashboard, feed, interests, network, search

TEMPLATE_DIR = Path(__file__).parent / "templates"
STATIC_DIR = Path(__file__).parent / "static"


def create_web_app(
    agent: Agent,
    store: KnowledgeStore,
    search_client: Optional[YouSearchClient] = None,
    registry: Optional[AgentRegistry] = None,
    port: int = 8080,
) -> FastAPI:
    """Create the full web app with UI routes and A2A protocol endpoints."""
    # Create base A2A app
    a2a_app = create_a2a_app(agent, store, search_client, port=port)

    # Create web app
    app = FastAPI(title=f"YouAgent Web - {agent.name}")

    # Set up templates and static files
    templates = Jinja2Templates(directory=str(TEMPLATE_DIR))
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    # Store shared state
    app.state.store = store
    app.state.search_client = search_client
    app.state.registry = registry
    app.state.templates = templates
    app.state.agent = agent

    # Include web routes
    app.include_router(dashboard.router)
    app.include_router(agents.router)
    app.include_router(feed.router)
    app.include_router(interests.router)
    app.include_router(network.router)
    app.include_router(search.router)

    # Mount A2A endpoints
    app.mount("/a2a-api", a2a_app)

    # Also serve agent card at well-known path on the web app
    @app.get("/.well-known/agent.json")
    async def agent_card():
        from fastapi.responses import JSONResponse
        from youagent.a2a.agent_card import generate_agent_card
        card = generate_agent_card(agent, endpoint=f"http://localhost:{port}/a2a-api/a2a")
        return JSONResponse(
            content=card.model_dump(by_alias=True),
            headers={"Access-Control-Allow-Origin": "*"},
        )

    return app

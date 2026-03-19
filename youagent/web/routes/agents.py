import json

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from youagent.a2a.agent_card import generate_agent_card
from youagent.models.agent import Agent
from youagent.models.interest import Interest

router = APIRouter(prefix="/agents")


@router.get("", response_class=HTMLResponse)
async def list_agents(request: Request):
    store = request.app.state.store
    agents = await store.list_agents()
    return request.app.state.templates.TemplateResponse("agents/list.html", {
        "request": request,
        "active": "agents",
        "version": "0.1.0",
        "agents": [
            {"id": a.id, "name": a.name, "description": a.description,
             "created_at": str(a.created_at)}
            for a in agents
        ],
    })


@router.get("/new", response_class=HTMLResponse)
async def create_form(request: Request):
    return request.app.state.templates.TemplateResponse("agents/create.html", {
        "request": request,
        "active": "agents",
        "version": "0.1.0",
    })


@router.post("", response_class=HTMLResponse)
async def create_agent(
    request: Request,
    name: str = Form(...),
    description: str = Form(""),
    interests: str = Form(""),
):
    store = request.app.state.store
    agent = Agent(name=name, description=description or f"Agent: {name}")
    interest_paths = [p.strip() for p in interests.split(",") if p.strip()]
    for path in interest_paths:
        agent.add_interest(Interest(path=path))
    await store.save_agent(agent)
    for i in agent.card.x_youagent.interests:
        await store.save_interest(agent.id, i)
    return RedirectResponse(f"/agents/{agent.id}", status_code=303)


@router.get("/{agent_id}", response_class=HTMLResponse)
async def agent_detail(request: Request, agent_id: str):
    store = request.app.state.store
    agent = await store.get_agent(agent_id)
    if not agent:
        return HTMLResponse("Agent not found", status_code=404)
    interests = await store.list_interests(agent.id)
    card = generate_agent_card(agent)

    return request.app.state.templates.TemplateResponse("agents/detail.html", {
        "request": request,
        "active": "agents",
        "version": "0.1.0",
        "agent": {
            "id": agent.id, "name": agent.name, "description": agent.description,
            "created_at": str(agent.created_at),
        },
        "interests": [
            {"id": i.id, "path": i.path, "cadence": i.cadence, "priority": i.priority}
            for i in interests
        ],
        "card_json": json.dumps(card.model_dump(by_alias=True), indent=2),
    })


@router.delete("/{agent_id}")
async def delete_agent(request: Request, agent_id: str):
    store = request.app.state.store
    await store.delete_agent(agent_id)
    return RedirectResponse("/agents", status_code=303)

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse

from youagent.scheduler.jobs import run_search_for_interest

router = APIRouter(prefix="/search")


@router.get("", response_class=HTMLResponse)
async def search_page(request: Request):
    store = request.app.state.store
    agents = await store.list_agents()

    return request.app.state.templates.TemplateResponse("search/index.html", {
        "request": request,
        "active": "search",
        "version": "0.1.0",
        "agents": [{"id": a.id, "name": a.name} for a in agents],
    })


@router.post("/run", response_class=HTMLResponse)
async def run_search(request: Request, agent_id: str = Form(...)):
    store = request.app.state.store
    search_client = request.app.state.search_client

    if not search_client:
        return HTMLResponse("<p class='text-red-400'>No API key configured.</p>")

    agent = await store.get_agent(agent_id)
    if not agent:
        return HTMLResponse("<p class='text-red-400'>Agent not found.</p>")

    interests = await store.list_interests(agent.id)
    all_entries = []

    for interest in interests:
        count = await run_search_for_interest(agent.id, interest, search_client, store)
        if count > 0:
            entries = await store.get_entries(agent.id, limit=count)
            all_entries.extend(entries)

    return request.app.state.templates.TemplateResponse("search/_results.html", {
        "request": request,
        "results": [
            {"title": e.title, "summary": e.summary, "sources": e.sources}
            for e in all_entries
        ],
    })

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse

from youagent.models.interest import Interest
from youagent.taxonomy.loader import load_taxonomy

router = APIRouter(prefix="/interests")


@router.get("", response_class=HTMLResponse)
async def interests_page(request: Request):
    store = request.app.state.store
    agents = await store.list_agents()
    taxonomy = load_taxonomy()

    agents_with_interests = []
    for agent in agents:
        interests = await store.list_interests(agent.id)
        agent_data = {
            "id": agent.id, "name": agent.name,
            "_interests": [
                {"id": i.id, "path": i.path, "cadence": i.cadence, "priority": i.priority}
                for i in interests
            ],
        }
        agents_with_interests.append(agent_data)

    return request.app.state.templates.TemplateResponse("interests/list.html", {
        "request": request,
        "active": "interests",
        "version": "0.1.0",
        "agents": agents_with_interests,
        "taxonomy_paths": taxonomy.all_leaf_paths(),
    })


@router.post("/{agent_id}", response_class=HTMLResponse)
async def add_interest(
    request: Request,
    agent_id: str,
    path: str = Form(...),
    cadence: str = Form("24h"),
    priority: str = Form("medium"),
):
    store = request.app.state.store
    interest = Interest(path=path, cadence=cadence, priority=priority)
    await store.save_interest(agent_id, interest)

    return HTMLResponse(f"""
    <div class="bg-slate-800 rounded p-3 border border-slate-700 flex justify-between items-center">
      <div>
        <span class="text-cyan-400">{path}</span>
        <span class="text-slate-500 text-sm ml-2">every {cadence} · {priority}</span>
      </div>
      <button hx-delete="/interests/{agent_id}/{interest.id}" hx-target="closest div" hx-swap="outerHTML"
        class="text-red-400 hover:text-red-300 text-sm">Remove</button>
    </div>
    """)


@router.delete("/{agent_id}/{interest_id}")
async def remove_interest(request: Request, agent_id: str, interest_id: str):
    store = request.app.state.store
    await store.delete_interest(interest_id)
    return HTMLResponse("")

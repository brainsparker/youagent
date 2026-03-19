from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

router = APIRouter()


@router.get("/", response_class=HTMLResponse)
async def dashboard(request: Request):
    store = request.app.state.store
    agents = await store.list_agents()

    total_interests = 0
    for agent in agents:
        interests = await store.list_interests(agent.id)
        total_interests += len(interests)

    entries_count = 0
    for agent in agents:
        entries = await store.get_entries(agent.id, limit=1000)
        entries_count += len(entries)

    feed = await store.get_feed(unread_only=True, limit=1000)
    unread_count = len(feed)

    recent_feed = await store.get_feed(limit=5)

    return request.app.state.templates.TemplateResponse("dashboard.html", {
        "request": request,
        "active": "dashboard",
        "version": "0.1.0",
        "stats": {
            "agents": len(agents),
            "interests": total_interests,
            "entries": entries_count,
            "unread": unread_count,
        },
        "recent_feed": [
            {"headline": f.headline, "body": f.body, "topic_path": f.topic_path,
             "created_at": str(f.created_at)}
            for f in recent_feed
        ],
    })


@router.get("/api/stats", response_class=HTMLResponse)
async def stats_partial(request: Request):
    """HTMX partial for auto-refreshing stats."""
    store = request.app.state.store
    agents = await store.list_agents()
    total_interests = 0
    for agent in agents:
        total_interests += len(await store.list_interests(agent.id))
    entries_count = sum(len(await store.get_entries(a.id, limit=1000)) for a in agents)
    unread_count = len(await store.get_feed(unread_only=True, limit=1000))

    return HTMLResponse(f"""
    <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
      <p class="text-slate-400 text-sm">Agents</p>
      <p class="text-3xl font-bold text-white">{len(agents)}</p>
    </div>
    <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
      <p class="text-slate-400 text-sm">Interests</p>
      <p class="text-3xl font-bold text-white">{total_interests}</p>
    </div>
    <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
      <p class="text-slate-400 text-sm">Knowledge Entries</p>
      <p class="text-3xl font-bold text-white">{entries_count}</p>
    </div>
    <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
      <p class="text-slate-400 text-sm">Unread Feed</p>
      <p class="text-3xl font-bold text-cyan-400">{unread_count}</p>
    </div>
    """)

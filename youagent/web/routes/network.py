import uuid

from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse

from youagent.a2a.client import A2AClient
from youagent.a2a.models import Message, TextPart

router = APIRouter(prefix="/network")


@router.get("", response_class=HTMLResponse)
async def network_page(request: Request):
    store = request.app.state.store
    registry = request.app.state.registry
    agents = registry.list_agents() if registry else []
    agent = getattr(request.app.state, "agent", None)

    # Get subscriptions (following list)
    subscriptions = []
    suggestions = []
    if agent:
        subscriptions = await store.get_subscriptions(agent.id, active_only=False)
        # Auto-discover suggested follows
        if registry:
            from youagent.a2a.client import A2AClient as _A2AClient
            from youagent.network.follower import NetworkFollower
            _client = _A2AClient()
            follower = NetworkFollower(store, _client)
            try:
                suggestions = await follower.auto_discover(agent.id, registry)
                # Exclude agents already being followed
                followed_ids = {s["remote_agent_id"] for s in subscriptions}
                suggestions = [c for c in suggestions if c.id not in followed_ids]
            except Exception:
                suggestions = []
            await _client.close()

    return request.app.state.templates.TemplateResponse("network/index.html", {
        "request": request,
        "active": "network",
        "version": "0.1.0",
        "agents": agents,
        "subscriptions": subscriptions,
        "suggestions": suggestions,
    })


@router.post("/connect", response_class=HTMLResponse)
async def connect_agent(request: Request, url: str = Form(...)):
    registry = request.app.state.registry
    if not registry:
        return HTMLResponse("<p class='text-red-400'>Registry not configured</p>")

    try:
        card = await registry.discover_by_url(url)
        skills_html = ""
        for skill in card.skills:
            for tag in skill.tags[:3]:
                skills_html += f'<span class="tag bg-slate-700 text-slate-300">{tag}</span> '

        return HTMLResponse(f"""
        <div class="bg-slate-800 rounded-lg p-4 border border-slate-700">
          <h3 class="font-semibold text-white">{card.name}</h3>
          <p class="text-sm text-slate-400 mt-1">{card.description}</p>
          <p class="text-xs text-slate-500 mt-1">{card.endpoint}</p>
          <div class="flex gap-1 mt-2 flex-wrap">{skills_html}</div>
          <div class="flex gap-2 mt-3">
            <form hx-post="/network/follow" hx-target="#follow-result-{card.id}" class="inline">
              <input type="hidden" name="url" value="{url}">
              <input type="hidden" name="agent_id" value="{card.id}">
              <input type="hidden" name="endpoint" value="{card.endpoint}">
              <input type="hidden" name="name" value="{card.name}">
              <button type="submit" class="bg-cyan-600 hover:bg-cyan-700 px-3 py-1 rounded text-sm text-white">Follow</button>
            </form>
            <form hx-post="/network/{card.id}/ask" hx-target="#response-{card.id}" class="flex gap-2 flex-1">
              <input type="text" name="query" placeholder="Ask this agent..."
                class="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-white">
              <button type="submit" class="bg-slate-600 hover:bg-slate-500 px-3 py-1 rounded text-sm">Ask</button>
            </form>
          </div>
          <div id="follow-result-{card.id}" class="mt-2"></div>
          <div id="response-{card.id}" class="mt-2"></div>
        </div>
        """)
    except Exception as e:
        return HTMLResponse(f"<p class='text-red-400'>Failed to connect: {e}</p>")


@router.post("/follow", response_class=HTMLResponse)
async def follow_agent(
    request: Request,
    url: str = Form(...),
    agent_id: str = Form(...),
    endpoint: str = Form(...),
    name: str = Form(""),
):
    """Follow a remote agent."""
    store = request.app.state.store
    agent = getattr(request.app.state, "agent", None)
    if not agent:
        return HTMLResponse('<p class="text-red-400">No local agent configured.</p>')

    # Check if already following
    subs = await store.get_subscriptions(agent.id, active_only=False)
    for sub in subs:
        if sub["remote_agent_id"] == agent_id:
            if not sub["active"]:
                await store.set_subscription_active(sub["id"], True)
                return HTMLResponse(f'<p class="text-green-400">Re-activated follow for {name}</p>')
            return HTMLResponse(f'<p class="text-yellow-400">Already following {name}</p>')

    sub = {
        "id": str(uuid.uuid4()),
        "agent_id": agent.id,
        "remote_agent_id": agent_id,
        "remote_endpoint": endpoint,
        "topics": [],
        "cadence": "6h",
        "last_polled": None,
        "active": 1,
        "remote_agent_name": name,
    }
    await store.save_subscription(sub)
    return HTMLResponse(f'<p class="text-green-400">Now following {name}! Posts will appear in your timeline.</p>')


@router.post("/unfollow/{remote_agent_id}", response_class=HTMLResponse)
async def unfollow_agent(request: Request, remote_agent_id: str):
    """Unfollow a remote agent."""
    store = request.app.state.store
    agent = getattr(request.app.state, "agent", None)
    if not agent:
        return HTMLResponse("")

    subs = await store.get_subscriptions(agent.id, active_only=False)
    for sub in subs:
        if sub["remote_agent_id"] == remote_agent_id:
            await store.set_subscription_active(sub["id"], False)
            return HTMLResponse('<p class="text-red-400">Unfollowed.</p>')

    return HTMLResponse('<p class="text-yellow-400">Not following this agent.</p>')


@router.post("/{agent_id}/ask", response_class=HTMLResponse)
async def ask_agent(request: Request, agent_id: str, query: str = Form(...)):
    registry = request.app.state.registry
    if not registry:
        return HTMLResponse("<p class='text-red-400'>Registry not configured</p>")

    card = registry.get(agent_id)
    if not card:
        return HTMLResponse("<p class='text-red-400'>Agent not found in registry</p>")

    message = Message(role="user", parts=[TextPart(text=query)])
    client = A2AClient()
    try:
        result = await client.send_message(card.endpoint, message)
        status = result.get("status", {}).get("state", "unknown")
        response_parts = []
        for artifact in result.get("artifacts", []):
            for part in artifact.get("parts", []):
                if part.get("type") == "text":
                    response_parts.append(part["text"])

        response_text = "\n".join(response_parts) if response_parts else "No response content"
        return HTMLResponse(f"""
        <div class="bg-slate-700 rounded p-3 mt-2 text-sm">
          <p class="text-xs text-slate-400 mb-1">Status: {status}</p>
          <p class="text-slate-300">{response_text}</p>
        </div>
        """)
    except Exception as e:
        return HTMLResponse(f"<p class='text-red-400 text-sm mt-2'>Error: {e}</p>")
    finally:
        await client.close()

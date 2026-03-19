from fastapi import APIRouter, Form, Request
from fastapi.responses import HTMLResponse

from youagent.a2a.client import A2AClient
from youagent.a2a.models import Message, TextPart

router = APIRouter(prefix="/network")


@router.get("", response_class=HTMLResponse)
async def network_page(request: Request):
    registry = request.app.state.registry
    agents = registry.list_agents() if registry else []

    return request.app.state.templates.TemplateResponse("network/index.html", {
        "request": request,
        "active": "network",
        "version": "0.1.0",
        "agents": agents,
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
          <form hx-post="/network/{card.id}/ask" hx-target="#response-{card.id}" class="mt-3 flex gap-2">
            <input type="text" name="query" placeholder="Ask this agent..."
              class="flex-1 bg-slate-700 border border-slate-600 rounded px-2 py-1 text-sm text-white">
            <button type="submit" class="bg-slate-600 hover:bg-slate-500 px-3 py-1 rounded text-sm">Ask</button>
          </form>
          <div id="response-{card.id}" class="mt-2"></div>
        </div>
        """)
    except Exception as e:
        return HTMLResponse(f"<p class='text-red-400'>Failed to connect: {e}</p>")


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

from fastapi import APIRouter, Form, Request
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

    # Get latest briefing for the first agent
    latest_briefing = None
    if agents:
        briefing = await store.get_latest_briefing(agents[0].id)
        if briefing:
            summary = ""
            for s in briefing.sections:
                if s.kind == "executive_summary":
                    summary = s.content
                    break
            latest_briefing = {
                "id": briefing.id,
                "created_at": str(briefing.created_at)[:19],
                "summary": summary,
            }

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
             "created_at": str(f.created_at), "source_origin": f.source_origin}
            for f in recent_feed
        ],
        "latest_briefing": latest_briefing,
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
      <p class="text-slate-400 text-sm">Unread</p>
      <p class="text-3xl font-bold text-cyan-400">{unread_count}</p>
    </div>
    """)


@router.post("/ask", response_class=HTMLResponse)
async def ask_question(request: Request, question: str = Form(...)):
    """Q&A widget endpoint — answers questions from accumulated knowledge."""
    store = request.app.state.store
    agent = getattr(request.app.state, "agent", None)

    if not agent:
        return HTMLResponse('<p class="text-red-400">No agent configured.</p>')

    try:
        from youagent.config.settings import YouAgentSettings
        from youagent.qa.engine import QAEngine
        from youagent.synthesis.llm_client import create_llm_client

        settings = YouAgentSettings.load()
        llm_client = create_llm_client(settings)

        if not llm_client:
            return HTMLResponse('<p class="text-yellow-400">No LLM configured. Set up an API key to enable Q&A.</p>')

        qa = QAEngine(store, llm_client)
        try:
            response = await qa.answer(agent.id, question)
        finally:
            await llm_client.close()

        import html
        sources_html = ""
        if response.sources:
            sources_html = '<div class="mt-2 text-xs text-slate-500">'
            for src in response.sources[:5]:
                safe_src = html.escape(src)
                sources_html += f'<a href="{safe_src}" target="_blank" class="text-cyan-500 hover:underline block">{safe_src}</a>'
            sources_html += "</div>"

        return HTMLResponse(f"""
        <div class="bg-slate-800 rounded-lg p-4 border border-cyan-800">
          <div class="flex justify-between items-center mb-2">
            <span class="text-xs text-cyan-400 uppercase tracking-wide">Answer</span>
            <span class="text-xs text-slate-500">{response.confidence} confidence · {response.entries_used} sources</span>
          </div>
          <div class="text-slate-300 text-sm prose prose-invert max-w-none">{html.escape(response.answer)}</div>
          {sources_html}
        </div>
        """)

    except Exception as e:
        import html
        return HTMLResponse(f'<p class="text-red-400">Error: {html.escape(str(e))}</p>')

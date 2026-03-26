import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from youagent.feed.ranker import TimelineRanker

router = APIRouter(prefix="/feed")


@router.get("", response_class=HTMLResponse)
async def feed_page(request: Request):
    store = request.app.state.store
    topic = request.query_params.get("topic", "")
    unread = request.query_params.get("unread", "") == "true"

    items = await store.get_feed(topic=topic or None, unread_only=unread, limit=50)

    # Apply timeline ranking
    agent = getattr(request.app.state, "agent", None)
    if agent:
        ranker = TimelineRanker(store)
        items = await ranker.rank(items, agent.id)
    items = items[:20]

    # Gather unique topics for filter
    all_feed = await store.get_feed(limit=500)
    topics = sorted({f.topic_path for f in all_feed if f.topic_path})

    return request.app.state.templates.TemplateResponse("feed/index.html", {
        "request": request,
        "active": "feed",
        "version": "0.1.0",
        "items": [
            {"id": f.id, "headline": f.headline, "body": f.body,
             "topic_path": f.topic_path, "created_at": str(f.created_at),
             "read": f.read, "source_origin": f.source_origin,
             "source_agent_id": f.source_agent_id,
             "source_agent_name": f.source_agent_name,
             "parent_post_id": f.parent_post_id}
            for f in items
        ],
        "topics": topics,
        "topic": topic,
        "unread": unread,
        "has_more": len(items) == 20,
        "offset": 20,
    })


@router.get("/items", response_class=HTMLResponse)
async def feed_items_partial(request: Request):
    """HTMX partial for feed items."""
    store = request.app.state.store
    topic = request.query_params.get("topic", "")
    unread = request.query_params.get("unread", "") == "true"
    offset = int(request.query_params.get("offset", "0"))

    all_items = await store.get_feed(
        topic=topic or None, unread_only=unread, limit=offset + 20
    )
    items = all_items[offset:] if offset else all_items[:20]

    return request.app.state.templates.TemplateResponse("feed/_items.html", {
        "request": request,
        "items": [
            {"id": f.id, "headline": f.headline, "body": f.body,
             "topic_path": f.topic_path, "created_at": str(f.created_at),
             "read": f.read, "source_origin": f.source_origin,
             "source_agent_id": f.source_agent_id,
             "source_agent_name": f.source_agent_name,
             "parent_post_id": f.parent_post_id}
            for f in items
        ],
        "has_more": len(items) == 20,
        "offset": offset + 20,
        "topic": topic,
        "unread": str(unread).lower(),
    })


@router.patch("/{item_id}/read")
async def mark_read(request: Request, item_id: str):
    store = request.app.state.store
    await store.mark_read(item_id)
    return HTMLResponse("")


@router.post("/{item_id}/respond", response_class=HTMLResponse)
async def respond_to_item(request: Request, item_id: str):
    """Run deeper investigation on a feed item and publish a response post."""
    import html as html_mod

    store = request.app.state.store
    agent = getattr(request.app.state, "agent", None)
    if not agent:
        return HTMLResponse('<p class="text-red-400">No agent configured.</p>')

    try:
        from youagent.config.settings import YouAgentSettings
        from youagent.respond.engine import RespondEngine
        from youagent.search.client import YouSearchClient
        from youagent.synthesis.llm_client import create_llm_client

        settings = YouAgentSettings.load()
        llm_client = create_llm_client(settings)
        if not llm_client:
            return HTMLResponse('<p class="text-yellow-400">No LLM configured.</p>')

        search_client = getattr(request.app.state, "search_client", None)
        if not search_client:
            return HTMLResponse('<p class="text-yellow-400">No search client configured.</p>')

        engine = RespondEngine(store, search_client, llm_client)
        try:
            result = await engine.respond(agent.id, item_id)
        finally:
            await llm_client.close()

        safe_title = html_mod.escape(result["title"])
        safe_summary = html_mod.escape(result.get("summary", ""))
        return HTMLResponse(f"""
        <div class="bg-slate-800 rounded-lg p-4 border border-green-800 mt-2">
          <div class="flex items-center gap-2 mb-2">
            <span class="tag bg-green-900 text-green-300 text-xs px-2 py-0.5 rounded">RESPONSE</span>
            <span class="text-xs text-slate-400">New post published</span>
          </div>
          <h4 class="font-semibold text-white">{safe_title}</h4>
          <p class="text-slate-400 text-sm mt-1">{safe_summary[:300]}</p>
        </div>
        """)
    except Exception as e:
        import html as html_mod
        return HTMLResponse(f'<p class="text-red-400 text-sm mt-2">Error: {html_mod.escape(str(e))}</p>')


@router.post("/{item_id}/engage")
async def engage(request: Request, item_id: str):
    """Record an engagement event for timeline ranking."""
    store = request.app.state.store
    agent = getattr(request.app.state, "agent", None)
    if not agent:
        return HTMLResponse("")

    try:
        body = await request.json()
    except Exception:
        body = {}

    event_type = body.get("event_type", "click")
    metadata = body.get("metadata", {})

    event = {
        "id": str(uuid.uuid4()),
        "agent_id": agent.id,
        "feed_item_id": item_id,
        "event_type": event_type,
        "metadata": metadata,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    await store.save_engagement(event)
    return HTMLResponse("")

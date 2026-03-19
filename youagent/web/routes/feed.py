from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

router = APIRouter(prefix="/feed")


@router.get("", response_class=HTMLResponse)
async def feed_page(request: Request):
    store = request.app.state.store
    topic = request.query_params.get("topic", "")
    unread = request.query_params.get("unread", "") == "true"

    items = await store.get_feed(topic=topic or None, unread_only=unread, limit=20)

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
             "read": f.read}
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
             "read": f.read}
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

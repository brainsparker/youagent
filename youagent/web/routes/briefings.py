from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

router = APIRouter(prefix="/briefings", tags=["briefings"])


@router.get("", response_class=HTMLResponse)
async def briefings_list(request: Request):
    store = request.app.state.store
    agent = request.app.state.agent
    briefings = await store.get_briefings(agent.id, limit=20)

    items = []
    for b in briefings:
        summary = ""
        for s in b.sections:
            if s.kind == "executive_summary":
                summary = s.content
                break
        items.append({
            "id": b.id,
            "created_at": str(b.created_at)[:19],
            "provider": f"{b.llm_provider}/{b.llm_model}",
            "entry_count": len(b.entry_ids),
            "summary": summary,
        })

    return request.app.state.templates.TemplateResponse("briefings/index.html", {
        "request": request,
        "active": "briefings",
        "version": "0.1.0",
        "briefings": items,
    })


@router.get("/{briefing_id}", response_class=HTMLResponse)
async def briefing_detail(request: Request, briefing_id: str):
    store = request.app.state.store
    briefing = await store.get_briefing(briefing_id)
    if not briefing:
        return HTMLResponse("Briefing not found", status_code=404)

    sections = []
    for s in briefing.sections:
        sections.append({
            "kind": s.kind,
            "title": s.title,
            "content": s.content,
            "source_refs": s.source_refs,
        })

    return request.app.state.templates.TemplateResponse("briefings/detail.html", {
        "request": request,
        "active": "briefings",
        "version": "0.1.0",
        "briefing": {
            "id": briefing.id,
            "created_at": str(briefing.created_at)[:19],
            "provider": f"{briefing.llm_provider}/{briefing.llm_model}",
            "entry_count": len(briefing.entry_ids),
            "sections": sections,
        },
    })

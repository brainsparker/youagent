"""Hosted multi-tenant app — wraps web app with auth, rate limiting, onboarding."""

from pathlib import Path
from typing import Optional

import aiosqlite
from fastapi import FastAPI, Form, Request
from fastapi.responses import HTMLResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates

from youagent.a2a.registry import AgentRegistry
from youagent.config.defaults import DB_PATH, YOUAGENT_HOME
from youagent.hosted.auth import AuthStore, User, create_token, verify_token
from youagent.hosted.rate_limit import RateLimiter
from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.models.interest import Interest
from youagent.search.client import YouSearchClient
from youagent.web.app import STATIC_DIR, TEMPLATE_DIR
from youagent.web.routes import agents, dashboard, feed, interests, network, search

HOSTED_TEMPLATE_DIR = Path(__file__).parent / "templates"

# Rate limiters
search_limiter = RateLimiter(max_requests=10, window_seconds=3600)
register_limiter = RateLimiter(max_requests=5, window_seconds=3600)


async def create_hosted_app(
    db_path: Path = DB_PATH,
    shared_api_key: Optional[str] = None,
) -> FastAPI:
    """Create the hosted multi-tenant app."""
    app = FastAPI(title="YouAgent — Hosted Demo")

    # Initialize stores
    store = KnowledgeStore(db_path)
    await store.initialize()

    db = await aiosqlite.connect(str(db_path))
    auth_store = AuthStore(db)
    await auth_store.initialize()

    registry = AgentRegistry(registry_path=YOUAGENT_HOME / "registry.json")
    templates = Jinja2Templates(directory=[str(HOSTED_TEMPLATE_DIR), str(TEMPLATE_DIR)])

    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")

    app.state.store = store
    app.state.auth_store = auth_store
    app.state.registry = registry
    app.state.templates = templates
    app.state.shared_api_key = shared_api_key

    # --- Auth helpers ---

    async def get_current_user(request: Request) -> Optional[User]:
        token = request.cookies.get("token")
        if not token:
            return None
        user_id = verify_token(token)
        if not user_id:
            return None
        return await auth_store.get_user(user_id)

    # --- Auth middleware ---

    @app.middleware("http")
    async def auth_middleware(request: Request, call_next):
        path = request.url.path
        # Public paths
        public = ["/auth", "/.well-known", "/a2a", "/health", "/landing", "/static"]
        if any(path.startswith(p) for p in public):
            return await call_next(request)

        user = await get_current_user(request)
        if not user:
            if path == "/":
                return RedirectResponse("/landing")
            return RedirectResponse("/auth/login")

        request.state.user = user

        # Set search client for this user
        api_key = await auth_store.get_api_key(user.id) or shared_api_key
        request.app.state.search_client = (
            YouSearchClient(api_key=api_key) if api_key else None
        )

        return await call_next(request)

    # --- Health check ---

    @app.get("/health")
    async def health():
        agent_count = len(await store.list_agents())
        user_count = await auth_store.user_count()
        return {"status": "ok", "agents": agent_count, "users": user_count}

    # --- Landing page ---

    @app.get("/landing", response_class=HTMLResponse)
    async def landing(request: Request):
        agent_count = len(await store.list_agents())
        user_count = await auth_store.user_count()
        return templates.TemplateResponse("landing.html", {
            "request": request,
            "agent_count": agent_count,
            "user_count": user_count,
        })

    # --- Auth routes ---

    @app.get("/auth/register", response_class=HTMLResponse)
    async def register_page(request: Request):
        return templates.TemplateResponse("auth/register.html", {
            "request": request, "error": None,
        })

    @app.post("/auth/register", response_class=HTMLResponse)
    async def register(
        request: Request,
        email: str = Form(...),
        password: str = Form(...),
        confirm_password: str = Form(...),
    ):
        if password != confirm_password:
            return templates.TemplateResponse("auth/register.html", {
                "request": request, "error": "Passwords don't match",
            })

        if not register_limiter.is_allowed(request.client.host):
            return templates.TemplateResponse("auth/register.html", {
                "request": request, "error": "Too many registrations. Try again later.",
            })

        try:
            user = await auth_store.create_user(email, password)
        except Exception:
            return templates.TemplateResponse("auth/register.html", {
                "request": request, "error": "Email already registered",
            })

        token = create_token(user.id)
        response = RedirectResponse("/onboarding", status_code=303)
        response.set_cookie("token", token, httponly=True, max_age=86400)
        return response

    @app.get("/auth/login", response_class=HTMLResponse)
    async def login_page(request: Request):
        return templates.TemplateResponse("auth/login.html", {
            "request": request, "error": None,
        })

    @app.post("/auth/login", response_class=HTMLResponse)
    async def login(
        request: Request,
        email: str = Form(...),
        password: str = Form(...),
    ):
        user = await auth_store.authenticate(email, password)
        if not user:
            return templates.TemplateResponse("auth/login.html", {
                "request": request, "error": "Invalid email or password",
            })

        token = create_token(user.id)
        response = RedirectResponse("/", status_code=303)
        response.set_cookie("token", token, httponly=True, max_age=86400)
        return response

    @app.get("/auth/logout")
    async def logout():
        response = RedirectResponse("/landing")
        response.delete_cookie("token")
        return response

    # --- Onboarding ---

    @app.get("/onboarding", response_class=HTMLResponse)
    async def onboarding(request: Request):
        return templates.TemplateResponse("onboarding.html", {
            "request": request,
            "active": "dashboard",
            "version": "0.1.0",
        })

    @app.post("/onboarding", response_class=HTMLResponse)
    async def onboarding_submit(
        request: Request,
        api_key: str = Form(""),
        agent_name: str = Form(...),
        agent_interests: str = Form(""),
    ):
        user = request.state.user

        if api_key:
            await auth_store.set_api_key(user.id, api_key)

        agent = Agent(name=agent_name, description=f"Agent for {user.email}")
        for path in [p.strip() for p in agent_interests.split(",") if p.strip()]:
            agent.add_interest(Interest(path=path))
        await store.save_agent(agent)
        for i in agent.card.x_youagent.interests:
            await store.save_interest(agent.id, i)

        return RedirectResponse("/", status_code=303)

    # --- Include web routes (they use request.app.state.store) ---
    app.include_router(dashboard.router)
    app.include_router(agents.router)
    app.include_router(feed.router)
    app.include_router(interests.router)
    app.include_router(network.router)
    app.include_router(search.router)

    return app

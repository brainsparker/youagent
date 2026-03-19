"""Tests for hosted mode — auth, rate limiting, multi-tenant."""

import pytest
import aiosqlite
from httpx import ASGITransport, AsyncClient

from youagent.hosted.auth import AuthStore, create_token, verify_token
from youagent.hosted.rate_limit import RateLimiter
from youagent.hosted.app import create_hosted_app


# --- Auth Tests ---

class TestAuth:
    @pytest.fixture
    async def auth_store(self, tmp_path):
        db = await aiosqlite.connect(str(tmp_path / "test.db"))
        store = AuthStore(db)
        await store.initialize()
        yield store
        await db.close()

    async def test_create_user(self, auth_store):
        user = await auth_store.create_user("test@example.com", "password123")
        assert user.email == "test@example.com"
        assert user.id is not None

    async def test_authenticate_valid(self, auth_store):
        await auth_store.create_user("test@example.com", "password123")
        user = await auth_store.authenticate("test@example.com", "password123")
        assert user is not None
        assert user.email == "test@example.com"

    async def test_authenticate_invalid_password(self, auth_store):
        await auth_store.create_user("test@example.com", "password123")
        user = await auth_store.authenticate("test@example.com", "wrong")
        assert user is None

    async def test_authenticate_nonexistent(self, auth_store):
        user = await auth_store.authenticate("nope@example.com", "password")
        assert user is None

    async def test_duplicate_email_rejected(self, auth_store):
        await auth_store.create_user("test@example.com", "password123")
        with pytest.raises(Exception):
            await auth_store.create_user("test@example.com", "other")

    def test_create_and_verify_token(self):
        token = create_token("user-123")
        user_id = verify_token(token)
        assert user_id == "user-123"

    def test_verify_invalid_token(self):
        assert verify_token("bad-token") is None

    async def test_api_key_management(self, auth_store):
        user = await auth_store.create_user("test@example.com", "password123")
        await auth_store.set_api_key(user.id, "my-api-key")
        key = await auth_store.get_api_key(user.id)
        assert key == "my-api-key"


# --- Rate Limiting Tests ---

class TestRateLimiter:
    def test_allows_under_limit(self):
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        assert limiter.is_allowed("user-1") is True
        assert limiter.is_allowed("user-1") is True
        assert limiter.is_allowed("user-1") is True

    def test_blocks_over_limit(self):
        limiter = RateLimiter(max_requests=2, window_seconds=60)
        assert limiter.is_allowed("user-1") is True
        assert limiter.is_allowed("user-1") is True
        assert limiter.is_allowed("user-1") is False

    def test_different_keys_independent(self):
        limiter = RateLimiter(max_requests=1, window_seconds=60)
        assert limiter.is_allowed("user-1") is True
        assert limiter.is_allowed("user-2") is True
        assert limiter.is_allowed("user-1") is False

    def test_remaining(self):
        limiter = RateLimiter(max_requests=3, window_seconds=60)
        assert limiter.remaining("user-1") == 3
        limiter.is_allowed("user-1")
        assert limiter.remaining("user-1") == 2


# --- Hosted App Integration Tests ---

class TestHostedApp:
    @pytest.fixture
    async def client(self, tmp_path):
        app = await create_hosted_app(db_path=tmp_path / "test.db")
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client

    async def test_health_endpoint(self, client):
        resp = await client.get("/health")
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "ok"

    async def test_landing_page(self, client):
        resp = await client.get("/landing")
        assert resp.status_code == 200
        assert "Your agent" in resp.text

    async def test_unauthenticated_redirects_to_landing(self, client):
        resp = await client.get("/", follow_redirects=False)
        assert resp.status_code == 307
        assert "/landing" in resp.headers["location"]

    async def test_register_page(self, client):
        resp = await client.get("/auth/register")
        assert resp.status_code == 200
        assert "Create Account" in resp.text

    async def test_register_flow(self, client):
        resp = await client.post("/auth/register", data={
            "email": "test@example.com",
            "password": "password123",
            "confirm_password": "password123",
        }, follow_redirects=False)
        assert resp.status_code == 303
        assert "/onboarding" in resp.headers["location"]
        assert "token" in resp.cookies

    async def test_register_password_mismatch(self, client):
        resp = await client.post("/auth/register", data={
            "email": "test@example.com",
            "password": "password123",
            "confirm_password": "different",
        })
        assert resp.status_code == 200
        assert "match" in resp.text  # HTML-escaped: "don&#39;t match"

    async def test_login_page(self, client):
        resp = await client.get("/auth/login")
        assert resp.status_code == 200
        assert "Sign In" in resp.text

    async def test_login_flow(self, client):
        # Register first
        await client.post("/auth/register", data={
            "email": "login@example.com",
            "password": "password123",
            "confirm_password": "password123",
        })
        # Login
        resp = await client.post("/auth/login", data={
            "email": "login@example.com",
            "password": "password123",
        }, follow_redirects=False)
        assert resp.status_code == 303
        assert "token" in resp.cookies

    async def test_login_invalid_credentials(self, client):
        resp = await client.post("/auth/login", data={
            "email": "nope@example.com",
            "password": "wrong",
        })
        assert resp.status_code == 200
        assert "Invalid" in resp.text

    async def test_authenticated_dashboard(self, client):
        # Register
        resp = await client.post("/auth/register", data={
            "email": "dash@example.com",
            "password": "password123",
            "confirm_password": "password123",
        }, follow_redirects=False)
        token = resp.cookies.get("token")

        # Access dashboard with cookie
        client.cookies.set("token", token)
        resp = await client.get("/")
        assert resp.status_code == 200
        assert "Dashboard" in resp.text

    async def test_onboarding_creates_agent(self, client):
        # Register
        resp = await client.post("/auth/register", data={
            "email": "onboard@example.com",
            "password": "password123",
            "confirm_password": "password123",
        }, follow_redirects=False)
        token = resp.cookies.get("token")
        client.cookies.set("token", token)

        # Complete onboarding
        resp = await client.post("/onboarding", data={
            "api_key": "",
            "agent_name": "My First Agent",
            "agent_interests": "technology/ai",
        }, follow_redirects=False)
        assert resp.status_code == 303

        # Verify agent exists
        resp = await client.get("/agents")
        assert resp.status_code == 200
        assert "My First Agent" in resp.text

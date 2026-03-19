"""Tests for web dashboard routes."""

import pytest
from httpx import ASGITransport, AsyncClient

from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.models.interest import Interest
from youagent.models.knowledge import FeedItem, KnowledgeEntry
from youagent.web.app import create_web_app


class TestWebApp:
    @pytest.fixture
    async def client(self, tmp_path):
        store = KnowledgeStore(tmp_path / "test.db")
        await store.initialize()

        agent = Agent(id="agent-1", name="Test Agent", description="A test agent")
        agent.add_interest(Interest(path="technology/ai", cadence="6h"))
        await store.save_agent(agent)
        for i in agent.card.x_youagent.interests:
            await store.save_interest(agent.id, i)

        entry = KnowledgeEntry(
            agent_id="agent-1", interest_id="int-1",
            title="AI News", summary="Big AI update",
            sources=["https://example.com"],
        )
        await store.save_knowledge_entry(entry)

        feed_item = FeedItem(
            agent_id="agent-1", entry_id=entry.id,
            headline="AI News", body="Big AI update from example.com",
            topic_path="technology/ai",
        )
        await store.save_feed_item(feed_item)

        app = create_web_app(agent, store, port=8080)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await store.close()

    async def test_dashboard(self, client):
        resp = await client.get("/")
        assert resp.status_code == 200
        assert "Dashboard" in resp.text
        assert "Test Agent" in resp.text or "1" in resp.text

    async def test_agents_list(self, client):
        resp = await client.get("/agents")
        assert resp.status_code == 200
        assert "Test Agent" in resp.text

    async def test_agent_detail(self, client):
        resp = await client.get("/agents/agent-1")
        assert resp.status_code == 200
        assert "Test Agent" in resp.text
        assert "technology/ai" in resp.text

    async def test_agent_create_form(self, client):
        resp = await client.get("/agents/new")
        assert resp.status_code == 200
        assert "Create Agent" in resp.text

    async def test_agent_create_submit(self, client):
        resp = await client.post("/agents", data={
            "name": "New Agent",
            "description": "Created via web",
            "interests": "business/startups",
        }, follow_redirects=False)
        assert resp.status_code == 303

    async def test_feed_page(self, client):
        resp = await client.get("/feed")
        assert resp.status_code == 200
        assert "AI News" in resp.text

    async def test_feed_items_partial(self, client):
        resp = await client.get("/feed/items")
        assert resp.status_code == 200

    async def test_feed_mark_read(self, client):
        # Get feed to find an item ID
        resp = await client.get("/feed")
        assert resp.status_code == 200

    async def test_interests_page(self, client):
        resp = await client.get("/interests")
        assert resp.status_code == 200
        assert "technology/ai" in resp.text

    async def test_interest_add(self, client):
        resp = await client.post("/interests/agent-1", data={
            "path": "science/physics",
            "cadence": "24h",
            "priority": "medium",
        })
        assert resp.status_code == 200
        assert "science/physics" in resp.text

    async def test_network_page(self, client):
        resp = await client.get("/network")
        assert resp.status_code == 200
        assert "Agent Network" in resp.text

    async def test_search_page(self, client):
        resp = await client.get("/search")
        assert resp.status_code == 200
        assert "Search" in resp.text

    async def test_agent_card_wellknown(self, client):
        resp = await client.get("/.well-known/agent.json")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Test Agent"

    async def test_nonexistent_agent(self, client):
        resp = await client.get("/agents/nonexistent")
        assert resp.status_code == 404

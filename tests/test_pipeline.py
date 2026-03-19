import pytest
import httpx
import respx

from youagent.scheduler.jobs import run_search_for_interest
from youagent.knowledge.store import KnowledgeStore
from youagent.search.client import YouSearchClient
from youagent.models.agent import Agent
from youagent.models.interest import Interest


class TestSearchPipeline:
    @pytest.fixture
    async def store(self, tmp_path):
        db_path = tmp_path / "test.db"
        store = KnowledgeStore(db_path)
        await store.initialize()
        agent = Agent(id="agent-1", name="Test", description="Test")
        await store.save_agent(agent)
        yield store
        await store.close()

    @pytest.fixture
    def client(self):
        return YouSearchClient(api_key="test-key")

    @respx.mock
    async def test_search_pipeline_creates_entries(self, store, client):
        respx.get("https://api.ydc-index.io/search").mock(
            return_value=httpx.Response(200, json={
                "hits": [
                    {
                        "title": "AI Regulation 2026",
                        "description": "New AI rules take effect.",
                        "url": "https://example.com/ai-reg",
                        "snippets": ["EU AI Act enforcement begins."],
                    }
                ]
            })
        )
        respx.post("https://api.ydc-index.io/research").mock(
            return_value=httpx.Response(200, json={
                "answer": "The EU AI Act is being enforced in 2026.",
                "references": [{"title": "EU AI Act", "url": "https://example.com/ai-reg"}],
            })
        )

        interest = Interest(
            id="interest-1",
            path="technology/ai/regulation",
            queries=["AI regulation 2026"],
            cadence="6h",
        )

        count = await run_search_for_interest(
            agent_id="agent-1",
            interest=interest,
            client=client,
            store=store,
        )
        assert count >= 1

        entries = await store.get_entries("agent-1")
        assert len(entries) >= 1
        assert "AI" in entries[0].title

        feed = await store.get_feed(agent_id="agent-1")
        assert len(feed) >= 1

    @respx.mock
    async def test_pipeline_deduplicates(self, store, client):
        hit = {
            "title": "Same Article",
            "description": "Same content.",
            "url": "https://example.com/same",
            "snippets": ["Repeated info."],
        }
        respx.get("https://api.ydc-index.io/search").mock(
            return_value=httpx.Response(200, json={"hits": [hit]})
        )
        respx.post("https://api.ydc-index.io/research").mock(
            return_value=httpx.Response(200, json={
                "answer": "Same answer.",
                "references": [],
            })
        )

        interest = Interest(id="int-1", path="tech/ai", queries=["test"], cadence="6h")

        await run_search_for_interest("agent-1", interest, client, store)
        await run_search_for_interest("agent-1", interest, client, store)

        assert await store.url_exists("https://example.com/same")
        entries = await store.get_entries("agent-1")
        assert len(entries) == 1  # second run skips duplicate

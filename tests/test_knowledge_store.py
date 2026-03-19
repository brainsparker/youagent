import pytest

from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.models.interest import Interest
from youagent.models.knowledge import KnowledgeEntry, FeedItem, Source


class TestKnowledgeStore:
    @pytest.fixture
    async def store(self, tmp_path):
        db_path = tmp_path / "test.db"
        store = KnowledgeStore(db_path)
        await store.initialize()
        yield store
        await store.close()

    async def test_create_and_get_agent(self, store: KnowledgeStore):
        agent = Agent(name="Test Agent", description="A test agent")
        await store.save_agent(agent)
        fetched = await store.get_agent(agent.id)
        assert fetched is not None
        assert fetched.name == "Test Agent"

    async def test_list_agents(self, store: KnowledgeStore):
        a1 = Agent(name="Agent 1", description="First")
        a2 = Agent(name="Agent 2", description="Second")
        await store.save_agent(a1)
        await store.save_agent(a2)
        agents = await store.list_agents()
        assert len(agents) == 2

    async def test_delete_agent(self, store: KnowledgeStore):
        agent = Agent(name="Delete Me", description="To be deleted")
        await store.save_agent(agent)
        await store.delete_agent(agent.id)
        assert await store.get_agent(agent.id) is None

    async def test_save_and_get_interest(self, store: KnowledgeStore):
        agent = Agent(name="Test", description="Test")
        await store.save_agent(agent)
        interest = Interest(path="technology/ai/regulation", cadence="6h")
        await store.save_interest(agent.id, interest)
        interests = await store.list_interests(agent.id)
        assert len(interests) == 1
        assert interests[0].path == "technology/ai/regulation"

    async def test_save_knowledge_entry(self, store: KnowledgeStore):
        agent = Agent(name="Test", description="Test")
        await store.save_agent(agent)
        interest = Interest(path="technology/ai")
        await store.save_interest(agent.id, interest)
        entry = KnowledgeEntry(
            agent_id=agent.id,
            interest_id=interest.id,
            title="AI News",
            summary="Something happened in AI.",
            sources=["https://example.com"],
            relevance=0.9,
            novelty=0.8,
        )
        await store.save_knowledge_entry(entry)
        entries = await store.get_entries(agent.id)
        assert len(entries) == 1
        assert entries[0].title == "AI News"

    async def test_save_and_query_feed(self, store: KnowledgeStore):
        agent = Agent(name="Test", description="Test")
        await store.save_agent(agent)
        item = FeedItem(
            agent_id=agent.id,
            entry_id="entry-1",
            headline="Big News",
            body="Something important happened.",
            topic_path="technology/ai",
        )
        await store.save_feed_item(item)
        feed = await store.get_feed(agent_id=agent.id)
        assert len(feed) == 1
        assert feed[0].headline == "Big News"
        assert feed[0].read is False

    async def test_mark_feed_read(self, store: KnowledgeStore):
        agent = Agent(name="Test", description="Test")
        await store.save_agent(agent)
        item = FeedItem(
            agent_id=agent.id,
            entry_id="entry-1",
            headline="News",
            body="Content",
            topic_path="tech/ai",
        )
        await store.save_feed_item(item)
        await store.mark_read(item.id)
        feed = await store.get_feed(agent_id=agent.id, unread_only=True)
        assert len(feed) == 0

    async def test_url_exists(self, store: KnowledgeStore):
        source = Source(url="https://example.com/article", title="Test", domain="example.com")
        await store.save_source(source)
        assert await store.url_exists("https://example.com/article") is True
        assert await store.url_exists("https://other.com") is False

import pytest

from youagent.models.interest import Interest
from youagent.models.card import AgentCard, YouAgentExtensions, KnowledgeSharing
from youagent.models.agent import Agent
from youagent.models.knowledge import KnowledgeEntry, Source, FeedItem


class TestInterest:
    def test_create_with_defaults(self):
        i = Interest(path="technology/ai/regulation")
        assert i.path == "technology/ai/regulation"
        assert i.cadence == "24h"
        assert i.priority == "medium"
        assert i.queries is None
        assert i.id is not None

    def test_create_with_all_fields(self):
        i = Interest(
            path="technology/ai/regulation",
            queries=["AI regulation 2026", "EU AI Act"],
            cadence="6h",
            priority="high",
        )
        assert i.queries == ["AI regulation 2026", "EU AI Act"]
        assert i.cadence == "6h"
        assert i.priority == "high"

    def test_invalid_priority_rejected(self):
        with pytest.raises(ValueError):
            Interest(path="tech/ai", priority="urgent")

    def test_invalid_cadence_rejected(self):
        with pytest.raises(ValueError):
            Interest(path="tech/ai", cadence="banana")


class TestAgentCard:
    def test_create_minimal(self):
        card = AgentCard(name="Test Agent", description="A test agent")
        assert card.name == "Test Agent"
        assert card.version == "1.0.0"
        assert card.x_youagent is not None
        assert card.x_youagent.interests == []

    def test_create_with_extensions(self):
        ext = YouAgentExtensions(
            interests=[Interest(path="technology/ai")],
            knowledge_sharing=KnowledgeSharing(publish=True, subscribe=True),
        )
        card = AgentCard(
            name="Full Agent",
            description="An agent with extensions",
            url="http://localhost:8000",
            x_youagent=ext,
        )
        assert len(card.x_youagent.interests) == 1
        assert card.x_youagent.knowledge_sharing.publish is True

    def test_to_a2a_json(self):
        card = AgentCard(name="Test", description="Test agent")
        data = card.model_dump(by_alias=True)
        assert "x-youagent" in data
        assert "name" in data


class TestAgent:
    def test_create_agent(self):
        agent = Agent(name="My Agent", description="Tracks AI topics")
        assert agent.name == "My Agent"
        assert agent.id is not None
        assert agent.card is not None
        assert agent.card.name == "My Agent"
        assert agent.created_at is not None

    def test_agent_add_interest(self):
        agent = Agent(name="Test", description="Test")
        interest = Interest(path="technology/ai/regulation", cadence="6h")
        agent.add_interest(interest)
        assert len(agent.card.x_youagent.interests) == 1
        assert agent.card.x_youagent.interests[0].path == "technology/ai/regulation"


class TestKnowledgeModels:
    def test_create_source(self):
        s = Source(url="https://example.com/article", title="Test Article", domain="example.com")
        assert s.id is not None
        assert s.first_seen is not None

    def test_create_knowledge_entry(self):
        e = KnowledgeEntry(
            agent_id="agent-1",
            interest_id="interest-1",
            title="AI Regulation Update",
            summary="The EU passed new AI rules.",
            sources=["https://example.com/article"],
            relevance=0.85,
            novelty=0.9,
        )
        assert e.id is not None
        assert e.relevance == 0.85

    def test_create_feed_item(self):
        f = FeedItem(
            agent_id="agent-1",
            entry_id="entry-1",
            headline="AI Regulation Update",
            body="The EU passed new AI rules. [Source](https://example.com)",
            topic_path="technology/ai/regulation",
        )
        assert f.read is False

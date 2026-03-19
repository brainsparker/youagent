"""Tests for the intelligence synthesis engine."""

import json
from datetime import datetime, timedelta, timezone

import httpx
import pytest
import respx

from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.models.briefing import Briefing, BriefingSection
from youagent.models.interest import Interest
from youagent.models.knowledge import KnowledgeEntry
from youagent.synthesis.engine import SynthesisEngine
from youagent.synthesis.llm_client import LLMClient, LLMProvider
from youagent.synthesis.prompts import build_synthesis_prompt, parse_briefing_response


# --- Fixtures ---

@pytest.fixture
async def store(tmp_path):
    s = KnowledgeStore(tmp_path / "test.db")
    await s.initialize()
    yield s
    await s.close()


@pytest.fixture
def sample_agent():
    return Agent(name="TestAgent", description="A test agent")


@pytest.fixture
def sample_entries(sample_agent):
    now = datetime.now(timezone.utc)
    return [
        KnowledgeEntry(
            agent_id=sample_agent.id,
            interest_id="int-1",
            title="AI Regulation Update",
            summary="The EU proposed new AI safety regulations.",
            sources=["https://example.com/ai-reg"],
            relevance=0.9,
            novelty=0.8,
            created_at=now - timedelta(hours=2),
        ),
        KnowledgeEntry(
            agent_id=sample_agent.id,
            interest_id="int-1",
            title="AI Safety Debate",
            summary="Researchers disagree on timelines for AGI risk.",
            sources=["https://example.com/ai-safety"],
            relevance=0.85,
            novelty=0.7,
            created_at=now - timedelta(hours=1),
        ),
    ]


MOCK_LLM_RESPONSE = json.dumps([
    {
        "kind": "executive_summary",
        "title": "Executive Summary",
        "content": "AI regulation is advancing rapidly with new EU proposals.",
        "source_refs": ["https://example.com/ai-reg"],
    },
    {
        "kind": "key_developments",
        "title": "Key Developments",
        "content": "- EU proposed new AI safety regulations\n- Ongoing AGI timeline debate",
        "source_refs": ["https://example.com/ai-reg", "https://example.com/ai-safety"],
    },
    {
        "kind": "emerging_trends",
        "title": "Emerging Trends",
        "content": "Regulatory frameworks are converging globally.",
        "source_refs": [],
    },
    {
        "kind": "contradictions",
        "title": "Contradictions",
        "content": "Researchers disagree on AGI risk timelines vs regulatory urgency.",
        "source_refs": ["https://example.com/ai-safety"],
    },
    {
        "kind": "action_items",
        "title": "Action Items",
        "content": "- Monitor EU AI Act progress\n- Track AGI safety research papers",
        "source_refs": [],
    },
])


# --- Briefing Model Tests ---

class TestBriefingModel:
    def test_briefing_section_creation(self):
        section = BriefingSection(
            kind="executive_summary",
            title="Summary",
            content="Test content",
            source_refs=["https://example.com"],
        )
        assert section.kind == "executive_summary"
        assert section.title == "Summary"

    def test_briefing_creation(self):
        briefing = Briefing(
            agent_id="agent-1",
            sections=[
                BriefingSection(kind="executive_summary", title="Summary", content="Test"),
            ],
            entry_ids=["e1", "e2"],
            llm_provider="claude",
            llm_model="claude-sonnet-4-20250514",
        )
        assert briefing.agent_id == "agent-1"
        assert len(briefing.sections) == 1
        assert len(briefing.entry_ids) == 2
        assert briefing.id  # auto-generated

    def test_briefing_serialization(self):
        briefing = Briefing(
            agent_id="agent-1",
            sections=[
                BriefingSection(kind="key_developments", title="Key", content="Updates"),
            ],
            entry_ids=["e1"],
            llm_provider="openai",
            llm_model="gpt-4o",
        )
        data = briefing.model_dump()
        restored = Briefing(**data)
        assert restored.agent_id == briefing.agent_id
        assert restored.sections[0].kind == "key_developments"


# --- LLM Client Tests ---

class TestLLMClient:
    @respx.mock
    @pytest.mark.asyncio
    async def test_claude_completion(self):
        respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(200, json={
                "content": [{"type": "text", "text": "Hello from Claude"}],
            })
        )
        client = LLMClient(LLMProvider.CLAUDE, api_key="test-key")
        result = await client.complete("system", "user")
        assert result == "Hello from Claude"
        await client.close()

    @respx.mock
    @pytest.mark.asyncio
    async def test_openai_completion(self):
        respx.post("https://api.openai.com/v1/chat/completions").mock(
            return_value=httpx.Response(200, json={
                "choices": [{"message": {"content": "Hello from OpenAI"}}],
            })
        )
        client = LLMClient(LLMProvider.OPENAI, api_key="test-key")
        result = await client.complete("system", "user")
        assert result == "Hello from OpenAI"
        await client.close()

    def test_default_models(self):
        client = LLMClient(LLMProvider.CLAUDE, api_key="test")
        assert "claude" in client.model
        client_oai = LLMClient(LLMProvider.OPENAI, api_key="test")
        assert "gpt" in client_oai.model

    def test_custom_model(self):
        client = LLMClient(LLMProvider.CLAUDE, api_key="test", model="claude-opus-4-20250514")
        assert client.model == "claude-opus-4-20250514"


# --- Prompt Tests ---

class TestPrompts:
    def test_build_synthesis_prompt(self, sample_agent, sample_entries):
        system, user = build_synthesis_prompt(
            agent_name=sample_agent.name,
            topics=["technology/ai/regulation"],
            entries=sample_entries,
        )
        assert "intelligence analyst" in system
        assert "executive_summary" in system
        assert sample_agent.name in user
        assert "AI Regulation Update" in user
        assert "technology/ai/regulation" in user

    def test_prompt_with_previous_summary(self, sample_agent, sample_entries):
        system, user = build_synthesis_prompt(
            agent_name=sample_agent.name,
            topics=["technology/ai"],
            entries=sample_entries,
            previous_summary="Previously, we noted AI regulations were stalled.",
        )
        assert "Previous Briefing Summary" in user
        assert "stalled" in user

    def test_prompt_external_entries(self, sample_agent):
        entry = KnowledgeEntry(
            agent_id=sample_agent.id,
            interest_id="",  # empty = external
            title="External Intel",
            summary="From another agent",
            sources=["https://ext.example.com"],
        )
        _, user = build_synthesis_prompt(
            agent_name=sample_agent.name,
            topics=[],
            entries=[entry],
        )
        assert "[EXTERNAL]" in user

    def test_parse_briefing_response_json(self):
        sections = parse_briefing_response(MOCK_LLM_RESPONSE)
        assert len(sections) == 5
        assert sections[0].kind == "executive_summary"
        assert sections[1].kind == "key_developments"

    def test_parse_briefing_response_markdown_fenced(self):
        fenced = f"```json\n{MOCK_LLM_RESPONSE}\n```"
        sections = parse_briefing_response(fenced)
        assert len(sections) == 5

    def test_parse_briefing_response_malformed(self):
        with pytest.raises((json.JSONDecodeError, ValueError)):
            parse_briefing_response("not json at all")

    def test_parse_briefing_response_not_array(self):
        with pytest.raises(ValueError, match="array"):
            parse_briefing_response('{"kind": "executive_summary"}')


# --- Synthesis Engine Tests ---

class TestSynthesisEngine:
    @respx.mock
    @pytest.mark.asyncio
    async def test_generate_briefing(self, store, sample_agent, sample_entries):
        # Setup: save agent, interest, entries
        await store.save_agent(sample_agent)
        interest = Interest(path="technology/ai/regulation", cadence="6h")
        await store.save_interest(sample_agent.id, interest)
        for entry in sample_entries:
            await store.save_knowledge_entry(entry)

        # Mock LLM
        respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(200, json={
                "content": [{"type": "text", "text": MOCK_LLM_RESPONSE}],
            })
        )

        llm_client = LLMClient(LLMProvider.CLAUDE, api_key="test-key")
        engine = SynthesisEngine(store, llm_client)
        briefing = await engine.generate_briefing(sample_agent.id)
        await llm_client.close()

        assert briefing is not None
        assert briefing.agent_id == sample_agent.id
        assert len(briefing.sections) == 5
        assert len(briefing.entry_ids) == 2
        assert briefing.llm_provider == "claude"

        # Verify saved to store
        saved = await store.get_latest_briefing(sample_agent.id)
        assert saved is not None
        assert saved.id == briefing.id

    @pytest.mark.asyncio
    async def test_no_llm_client_returns_none(self, store, sample_agent):
        await store.save_agent(sample_agent)
        engine = SynthesisEngine(store, llm_client=None)
        result = await engine.generate_briefing(sample_agent.id)
        assert result is None

    @pytest.mark.asyncio
    async def test_no_entries_returns_none(self, store, sample_agent):
        await store.save_agent(sample_agent)
        interest = Interest(path="technology/ai", cadence="6h")
        await store.save_interest(sample_agent.id, interest)

        llm_client = LLMClient(LLMProvider.CLAUDE, api_key="test-key")
        engine = SynthesisEngine(store, llm_client)
        result = await engine.generate_briefing(sample_agent.id)
        await llm_client.close()
        assert result is None

    @pytest.mark.asyncio
    async def test_agent_not_found(self, store):
        engine = SynthesisEngine(store, llm_client=LLMClient(LLMProvider.CLAUDE, api_key="test"))
        result = await engine.generate_briefing("nonexistent")
        await engine.llm_client.close()
        assert result is None

    @respx.mock
    @pytest.mark.asyncio
    async def test_temporal_context(self, store, sample_agent, sample_entries):
        """Second briefing references previous one."""
        await store.save_agent(sample_agent)
        interest = Interest(path="technology/ai", cadence="6h")
        await store.save_interest(sample_agent.id, interest)

        # Save a previous briefing
        prev_briefing = Briefing(
            agent_id=sample_agent.id,
            sections=[BriefingSection(
                kind="executive_summary", title="Summary",
                content="AI regulation was stalled last week.",
            )],
            entry_ids=["old-1"],
            llm_provider="claude",
            llm_model="claude-sonnet-4-20250514",
            created_at=datetime.now(timezone.utc) - timedelta(hours=12),
        )
        await store.save_briefing(prev_briefing)

        # Add new entries (after the previous briefing)
        for entry in sample_entries:
            entry.created_at = datetime.now(timezone.utc)
            await store.save_knowledge_entry(entry)

        respx.post("https://api.anthropic.com/v1/messages").mock(
            return_value=httpx.Response(200, json={
                "content": [{"type": "text", "text": MOCK_LLM_RESPONSE}],
            })
        )

        llm_client = LLMClient(LLMProvider.CLAUDE, api_key="test-key")
        engine = SynthesisEngine(store, llm_client)
        briefing = await engine.generate_briefing(sample_agent.id)
        await llm_client.close()

        assert briefing is not None
        assert briefing.previous_briefing_id == prev_briefing.id


# --- Briefing Store CRUD Tests ---

class TestBriefingStore:
    @pytest.mark.asyncio
    async def test_save_and_get_briefing(self, store, sample_agent):
        await store.save_agent(sample_agent)
        briefing = Briefing(
            agent_id=sample_agent.id,
            sections=[
                BriefingSection(kind="executive_summary", title="Summary", content="Test"),
                BriefingSection(kind="key_developments", title="Key", content="Updates"),
            ],
            entry_ids=["e1", "e2"],
            llm_provider="claude",
            llm_model="claude-sonnet-4-20250514",
        )
        await store.save_briefing(briefing)

        retrieved = await store.get_briefing(briefing.id)
        assert retrieved is not None
        assert retrieved.id == briefing.id
        assert len(retrieved.sections) == 2
        assert retrieved.entry_ids == ["e1", "e2"]

    @pytest.mark.asyncio
    async def test_get_latest_briefing(self, store, sample_agent):
        await store.save_agent(sample_agent)
        now = datetime.now(timezone.utc)

        b1 = Briefing(
            agent_id=sample_agent.id,
            sections=[BriefingSection(kind="executive_summary", title="Old", content="Old")],
            entry_ids=["e1"],
            llm_provider="claude", llm_model="test",
            created_at=now - timedelta(hours=6),
        )
        b2 = Briefing(
            agent_id=sample_agent.id,
            sections=[BriefingSection(kind="executive_summary", title="New", content="New")],
            entry_ids=["e2"],
            llm_provider="claude", llm_model="test",
            created_at=now,
        )
        await store.save_briefing(b1)
        await store.save_briefing(b2)

        latest = await store.get_latest_briefing(sample_agent.id)
        assert latest.id == b2.id

    @pytest.mark.asyncio
    async def test_get_briefings_list(self, store, sample_agent):
        await store.save_agent(sample_agent)
        for i in range(3):
            b = Briefing(
                agent_id=sample_agent.id,
                sections=[BriefingSection(kind="executive_summary", title=f"B{i}", content=f"Content {i}")],
                entry_ids=[f"e{i}"],
                llm_provider="claude", llm_model="test",
            )
            await store.save_briefing(b)

        briefings = await store.get_briefings(sample_agent.id, limit=2)
        assert len(briefings) == 2

    @pytest.mark.asyncio
    async def test_get_entries_since(self, store, sample_agent):
        await store.save_agent(sample_agent)
        now = datetime.now(timezone.utc)

        old_entry = KnowledgeEntry(
            agent_id=sample_agent.id, interest_id="i1",
            title="Old", summary="Old entry",
            created_at=now - timedelta(hours=48),
        )
        new_entry = KnowledgeEntry(
            agent_id=sample_agent.id, interest_id="i1",
            title="New", summary="New entry",
            created_at=now - timedelta(hours=1),
        )
        await store.save_knowledge_entry(old_entry)
        await store.save_knowledge_entry(new_entry)

        since = now - timedelta(hours=24)
        entries = await store.get_entries_since(sample_agent.id, since)
        assert len(entries) == 1
        assert entries[0].title == "New"

    @pytest.mark.asyncio
    async def test_no_briefing_returns_none(self, store):
        result = await store.get_latest_briefing("nonexistent")
        assert result is None


# --- Web Route Tests ---

class TestWebRoutes:
    @pytest.mark.asyncio
    async def test_briefings_list_route(self, store, sample_agent):
        """Verify the briefings route handler can fetch data."""
        await store.save_agent(sample_agent)
        briefings = await store.get_briefings(sample_agent.id)
        assert isinstance(briefings, list)

    @pytest.mark.asyncio
    async def test_briefing_detail_route(self, store, sample_agent):
        """Verify briefing detail fetch works."""
        await store.save_agent(sample_agent)
        briefing = Briefing(
            agent_id=sample_agent.id,
            sections=[BriefingSection(kind="executive_summary", title="S", content="C")],
            entry_ids=["e1"],
            llm_provider="claude", llm_model="test",
        )
        await store.save_briefing(briefing)
        fetched = await store.get_briefing(briefing.id)
        assert fetched is not None
        assert fetched.sections[0].content == "C"

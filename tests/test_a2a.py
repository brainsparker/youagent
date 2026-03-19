"""Tests for A2A protocol implementation."""

import pytest
from httpx import ASGITransport, AsyncClient

from youagent.a2a.agent_card import generate_agent_card
from youagent.a2a.jsonrpc import JsonRpcDispatcher
from youagent.a2a.knowledge_handler import KnowledgeExchangeHandler
from youagent.a2a.models import (
    A2AAgentCard,
    AgentSkill,
    Artifact,
    DataPart,
    Message,
    Task,
    TaskState,
    TextPart,
)
from youagent.a2a.registry import AgentRegistry
from youagent.a2a.server import create_a2a_app
from youagent.a2a.task_manager import TaskManager
from youagent.knowledge.store import KnowledgeStore
from youagent.models.agent import Agent
from youagent.models.interest import Interest
from youagent.models.knowledge import KnowledgeEntry


# --- Model Tests ---

class TestA2AModels:
    def test_text_part(self):
        p = TextPart(text="hello")
        assert p.type == "text"
        assert p.text == "hello"

    def test_data_part(self):
        p = DataPart(data={"topic": "ai"})
        assert p.type == "data"
        assert p.data["topic"] == "ai"

    def test_message(self):
        m = Message(role="user", parts=[TextPart(text="hi")])
        assert m.role == "user"
        assert len(m.parts) == 1

    def test_task_default_state(self):
        t = Task()
        assert t.status.state == TaskState.WORKING

    def test_agent_card(self):
        card = A2AAgentCard(name="Test", description="Test agent")
        assert card.version == "0.3"
        assert card.capabilities.streaming is True
        data = card.model_dump(by_alias=True)
        assert "pushNotifications" in data["capabilities"]


# --- Agent Card Generation ---

class TestAgentCardGeneration:
    def test_generate_from_agent(self):
        agent = Agent(name="My Agent", description="Tracks AI")
        agent.add_interest(Interest(path="technology/ai/regulation", cadence="6h"))
        card = generate_agent_card(agent)
        assert card.name == "My Agent"
        assert len(card.skills) == 1
        assert "technology/ai/regulation" in card.skills[0].tags

    def test_generate_empty_interests(self):
        agent = Agent(name="Empty", description="No interests")
        card = generate_agent_card(agent)
        assert card.skills == []


# --- Task Manager ---

class TestTaskManager:
    async def test_create_task(self):
        tm = TaskManager()
        msg = Message(role="user", parts=[TextPart(text="hello")])
        task = await tm.create_task(msg)
        assert task.status.state == TaskState.WORKING
        assert len(task.history) == 1

    async def test_update_status(self):
        tm = TaskManager()
        msg = Message(role="user", parts=[TextPart(text="hello")])
        task = await tm.create_task(msg)
        updated = await tm.update_status(task.id, TaskState.COMPLETED)
        assert updated.status.state == TaskState.COMPLETED

    async def test_cancel_task(self):
        tm = TaskManager()
        msg = Message(role="user", parts=[TextPart(text="hello")])
        task = await tm.create_task(msg)
        assert await tm.cancel_task(task.id) is True
        t = await tm.get_task(task.id)
        assert t.status.state == TaskState.CANCELED

    async def test_cancel_completed_fails(self):
        tm = TaskManager()
        msg = Message(role="user", parts=[TextPart(text="hello")])
        task = await tm.create_task(msg)
        await tm.update_status(task.id, TaskState.COMPLETED)
        assert await tm.cancel_task(task.id) is False

    async def test_add_artifact(self):
        tm = TaskManager()
        msg = Message(role="user", parts=[TextPart(text="hello")])
        task = await tm.create_task(msg)
        artifact = Artifact(parts=[TextPart(text="result")])
        await tm.add_artifact(task.id, artifact)
        t = await tm.get_task(task.id)
        assert len(t.artifacts) == 1


# --- JSON-RPC Dispatcher ---

class TestJsonRpcDispatcher:
    async def test_dispatch_valid(self):
        dispatcher = JsonRpcDispatcher()

        async def echo(params):
            return params

        dispatcher.register("echo", echo)
        resp = await dispatcher.dispatch({"jsonrpc": "2.0", "method": "echo", "params": {"x": 1}, "id": 1})
        assert resp.result == {"x": 1}
        assert resp.id == 1

    async def test_dispatch_method_not_found(self):
        dispatcher = JsonRpcDispatcher()
        resp = await dispatcher.dispatch({"jsonrpc": "2.0", "method": "nope", "id": 1})
        assert resp.error is not None
        assert resp.error.code == -32601

    async def test_dispatch_invalid_jsonrpc(self):
        dispatcher = JsonRpcDispatcher()
        resp = await dispatcher.dispatch({"jsonrpc": "1.0", "method": "x", "id": 1})
        assert resp.error is not None
        assert resp.error.code == -32600


# --- Knowledge Exchange Handler ---

class TestKnowledgeExchangeHandler:
    @pytest.fixture
    async def setup(self, tmp_path):
        store = KnowledgeStore(tmp_path / "test.db")
        await store.initialize()
        agent = Agent(id="agent-1", name="Test", description="Test")
        await store.save_agent(agent)

        # Add some knowledge
        entry = KnowledgeEntry(
            agent_id="agent-1",
            interest_id="int-1",
            title="AI Regulation Update",
            summary="EU AI Act enforcement begins in 2026.",
            sources=["https://example.com/ai-reg"],
            relevance=0.9,
        )
        await store.save_knowledge_entry(entry)

        tm = TaskManager()
        handler = KnowledgeExchangeHandler(
            task_manager=tm, store=store, agent_id="agent-1"
        )
        yield handler, tm, store
        await store.close()

    async def test_handle_text_query(self, setup):
        handler, tm, _ = setup
        msg = Message(role="user", parts=[TextPart(text="AI regulation")])
        task = await tm.create_task(msg)
        result = await handler.handle_message(task, msg)
        assert result.status.state == TaskState.COMPLETED
        assert len(result.artifacts) > 0

    async def test_handle_no_results(self, setup):
        handler, tm, _ = setup
        msg = Message(role="user", parts=[TextPart(text="xyznonexistent12345")])
        task = await tm.create_task(msg)
        result = await handler.handle_message(task, msg)
        assert result.status.state == TaskState.COMPLETED

    async def test_handle_knowledge_share(self, setup):
        handler, tm, store = setup
        msg = Message(
            role="user",
            parts=[DataPart(data={
                "type": "knowledge_share",
                "entries": [
                    {"title": "Shared Entry", "summary": "Shared knowledge", "sources": []}
                ],
            })],
        )
        task = await tm.create_task(msg)
        result = await handler.handle_message(task, msg)
        assert result.status.state == TaskState.COMPLETED
        entries = await store.get_entries("agent-1")
        assert any(e.title == "Shared Entry" for e in entries)


# --- Registry ---

class TestAgentRegistry:
    def test_register_and_list(self):
        registry = AgentRegistry()
        card = A2AAgentCard(name="Agent A", description="Test")
        registry.register(card)
        assert len(registry.list_agents()) == 1

    def test_discover_by_topic(self):
        registry = AgentRegistry()
        card = A2AAgentCard(
            name="AI Agent", description="Tracks AI",
            skills=[AgentSkill(id="ke", name="KE", tags=["technology/ai/regulation"])],
        )
        registry.register(card)
        matches = registry.discover_by_topic("technology/ai")
        assert len(matches) == 1
        assert matches[0].name == "AI Agent"

    def test_discover_no_match(self):
        registry = AgentRegistry()
        card = A2AAgentCard(
            name="AI Agent", description="Tracks AI",
            skills=[AgentSkill(id="ke", name="KE", tags=["technology/ai"])],
        )
        registry.register(card)
        assert registry.discover_by_topic("business/startups") == []

    def test_persistence(self, tmp_path):
        path = tmp_path / "registry.json"
        reg1 = AgentRegistry(registry_path=path)
        card = A2AAgentCard(name="Persist", description="Test")
        reg1.register(card)

        reg2 = AgentRegistry(registry_path=path)
        assert len(reg2.list_agents()) == 1
        assert reg2.list_agents()[0].name == "Persist"


# --- A2A Server Integration ---

class TestA2AServer:
    @pytest.fixture
    async def client(self, tmp_path):
        store = KnowledgeStore(tmp_path / "test.db")
        await store.initialize()
        agent = Agent(id="agent-1", name="Test Agent", description="Test")
        agent.add_interest(Interest(path="technology/ai", cadence="6h"))
        await store.save_agent(agent)

        app = create_a2a_app(agent, store, port=8000)
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as client:
            yield client
        await store.close()

    async def test_agent_card_endpoint(self, client):
        resp = await client.get("/.well-known/agent.json")
        assert resp.status_code == 200
        data = resp.json()
        assert data["name"] == "Test Agent"
        assert data["version"] == "0.3"
        assert len(data["skills"]) == 1

    async def test_jsonrpc_message_send(self, client):
        resp = await client.post("/a2a", json={
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"type": "text", "text": "What do you know about AI?"}],
                },
            },
            "id": 1,
        })
        assert resp.status_code == 200
        data = resp.json()
        assert data["jsonrpc"] == "2.0"
        assert data["result"]["status"]["state"] in ["completed", "working"]
        assert "a2a-version" in resp.headers

    async def test_jsonrpc_tasks_get(self, client):
        # First create a task
        resp = await client.post("/a2a", json={
            "jsonrpc": "2.0",
            "method": "message/send",
            "params": {
                "message": {
                    "role": "user",
                    "parts": [{"type": "text", "text": "hello"}],
                },
            },
            "id": 1,
        })
        task_id = resp.json()["result"]["id"]

        # Then get it
        resp = await client.post("/a2a", json={
            "jsonrpc": "2.0",
            "method": "tasks/get",
            "params": {"id": task_id},
            "id": 2,
        })
        assert resp.status_code == 200
        assert resp.json()["result"]["id"] == task_id

    async def test_jsonrpc_method_not_found(self, client):
        resp = await client.post("/a2a", json={
            "jsonrpc": "2.0",
            "method": "nonexistent",
            "id": 1,
        })
        assert resp.status_code == 200
        assert resp.json()["error"]["code"] == -32601

    async def test_jsonrpc_parse_error(self, client):
        resp = await client.post("/a2a", content=b"not json", headers={"content-type": "application/json"})
        assert resp.status_code == 200
        assert resp.json()["error"]["code"] == -32700

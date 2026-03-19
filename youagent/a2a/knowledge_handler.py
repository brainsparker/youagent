"""Handle knowledge exchange between A2A agents."""

from typing import Optional

from youagent.a2a.models import (
    Artifact,
    DataPart,
    Message,
    Task,
    TaskState,
    TextPart,
)
from youagent.a2a.task_manager import TaskManager
from youagent.knowledge.store import KnowledgeStore
from youagent.models.knowledge import KnowledgeEntry
from youagent.search.client import YouSearchClient


class KnowledgeExchangeHandler:
    def __init__(
        self,
        task_manager: TaskManager,
        store: KnowledgeStore,
        search_client: Optional[YouSearchClient] = None,
        agent_id: str = "",
    ) -> None:
        self.task_manager = task_manager
        self.store = store
        self.search_client = search_client
        self.agent_id = agent_id

    async def handle_message(self, task: Task, message: Message) -> Task:
        """Process an incoming message and generate a response."""
        # Check for knowledge_share ingestion
        for part in message.parts:
            if isinstance(part, DataPart) and part.data.get("type") == "knowledge_share":
                return await self._handle_knowledge_share(task, part)

        # Extract query from message parts
        query = self._extract_query(message)
        topic = self._extract_topic(message)

        if not query and not topic:
            await self.task_manager.update_status(
                task.id, TaskState.FAILED, "No query or topic found in message"
            )
            return await self.task_manager.get_task(task.id)

        # Search local knowledge store
        entries = await self.store.get_entries(self.agent_id, limit=20)
        relevant = self._filter_relevant(entries, query, topic)

        if relevant:
            artifact = self._entries_to_artifact(relevant, topic or query)
            await self.task_manager.add_artifact(task.id, artifact)
            response = Message(
                role="agent",
                parts=[TextPart(text=f"Found {len(relevant)} relevant entries.")],
            )
            await self.task_manager.add_message(task.id, response)
            await self.task_manager.update_status(task.id, TaskState.COMPLETED)
        elif self.search_client and topic:
            # Trigger fresh search
            try:
                results = await self.search_client.search(query or topic)
                if results:
                    parts = [
                        TextPart(text=f"Fresh search results for '{topic}':"),
                        DataPart(data={
                            "results": [
                                {"title": r.title, "url": r.url, "description": r.description}
                                for r in results[:5]
                            ]
                        }),
                    ]
                    artifact = Artifact(parts=parts, metadata={"topic": topic, "fresh": True})
                    await self.task_manager.add_artifact(task.id, artifact)
                    response = Message(
                        role="agent",
                        parts=[TextPart(text=f"Found {len(results)} fresh results.")],
                    )
                    await self.task_manager.add_message(task.id, response)
                    await self.task_manager.update_status(task.id, TaskState.COMPLETED)
                else:
                    await self.task_manager.update_status(
                        task.id, TaskState.COMPLETED, "No results found"
                    )
            except Exception as e:
                await self.task_manager.update_status(task.id, TaskState.FAILED, str(e))
        else:
            response = Message(
                role="agent",
                parts=[TextPart(text="No relevant knowledge found for this topic.")],
            )
            await self.task_manager.add_message(task.id, response)
            await self.task_manager.update_status(task.id, TaskState.COMPLETED, "No results")

        return await self.task_manager.get_task(task.id)

    async def _handle_knowledge_share(self, task: Task, part: DataPart) -> Task:
        """Ingest shared knowledge entries."""
        entries_data = part.data.get("entries", [])
        count = 0
        for entry_data in entries_data:
            entry = KnowledgeEntry(
                agent_id=self.agent_id,
                interest_id=entry_data.get("interest_id", "shared"),
                title=entry_data.get("title", ""),
                summary=entry_data.get("summary", ""),
                sources=entry_data.get("sources", []),
                relevance=entry_data.get("relevance", 0.5),
                novelty=entry_data.get("novelty", 0.5),
            )
            await self.store.save_knowledge_entry(entry)
            count += 1

        response = Message(
            role="agent",
            parts=[TextPart(text=f"Ingested {count} shared knowledge entries.")],
        )
        await self.task_manager.add_message(task.id, response)
        await self.task_manager.update_status(task.id, TaskState.COMPLETED)
        return await self.task_manager.get_task(task.id)

    def _extract_query(self, message: Message) -> Optional[str]:
        for part in message.parts:
            if isinstance(part, TextPart):
                return part.text
        return None

    def _extract_topic(self, message: Message) -> Optional[str]:
        topic = message.metadata.get("topic")
        if topic:
            return topic
        for part in message.parts:
            if isinstance(part, DataPart) and "topic" in part.data:
                return part.data["topic"]
        return None

    def _filter_relevant(
        self, entries: list[KnowledgeEntry], query: Optional[str], topic: Optional[str]
    ) -> list[KnowledgeEntry]:
        if not entries:
            return []
        relevant = []
        search_terms = set()
        if query:
            search_terms.update(query.lower().split())
        if topic:
            search_terms.update(topic.replace("/", " ").lower().split())
        if not search_terms:
            return entries[:5]
        for entry in entries:
            text = f"{entry.title} {entry.summary}".lower()
            if any(term in text for term in search_terms):
                relevant.append(entry)
        return relevant[:10]

    def _entries_to_artifact(self, entries: list[KnowledgeEntry], topic: str) -> Artifact:
        parts: list = [
            TextPart(text=f"Knowledge entries for '{topic}':"),
            DataPart(data={
                "entries": [
                    {
                        "title": e.title,
                        "summary": e.summary,
                        "sources": e.sources,
                        "relevance": e.relevance,
                    }
                    for e in entries
                ]
            }),
        ]
        return Artifact(parts=parts, metadata={"topic": topic, "count": len(entries)})

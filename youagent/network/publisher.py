"""PostPublisher — publishes knowledge entries as posts for followers to retrieve."""

import logging
import uuid
from datetime import datetime, timezone

from youagent.knowledge.store import KnowledgeStore
from youagent.models.knowledge import KnowledgeEntry

logger = logging.getLogger(__name__)


class PostPublisher:
    def __init__(self, store: KnowledgeStore) -> None:
        self.store = store

    async def publish(self, entry: KnowledgeEntry, topic_path: str = "") -> str:
        """Create a post from a KnowledgeEntry. Returns post ID."""
        post = {
            "id": str(uuid.uuid4()),
            "agent_id": entry.agent_id,
            "entry_id": entry.id,
            "title": entry.title,
            "summary": entry.summary,
            "sources": entry.sources,
            "topic_path": topic_path,
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await self.store.save_post(post)
        logger.debug("Published post %s for entry %s", post["id"], entry.id)
        return post["id"]

    async def get_posts_since(self, agent_id: str, since: str) -> list[dict]:
        return await self.store.get_posts_since(agent_id, since)

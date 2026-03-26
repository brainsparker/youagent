"""NetworkFollower — polls followed agents for new posts and ingests them."""

import logging
import uuid
from datetime import datetime, timezone

from youagent.a2a.client import A2AClient
from youagent.a2a.models import JsonRpcRequest
from youagent.knowledge.store import KnowledgeStore
from youagent.models.knowledge import FeedItem, KnowledgeEntry

logger = logging.getLogger(__name__)


class NetworkFollower:
    def __init__(self, store: KnowledgeStore, a2a_client: A2AClient) -> None:
        self.store = store
        self.a2a_client = a2a_client

    async def poll_subscription(self, sub: dict) -> int:
        """Fetch posts from a followed agent, ingest as network items. Returns count."""
        since = sub.get("last_polled") or "2000-01-01T00:00:00"
        endpoint = sub["remote_endpoint"]

        try:
            # Call posts/list JSON-RPC method on the remote agent
            request = JsonRpcRequest(
                method="posts/list",
                params={"since": since, "agent_id": sub["remote_agent_id"]},
                id=1,
            )
            response = await self.a2a_client._client.post(
                endpoint, json=request.model_dump(),
            )
            response.raise_for_status()
            data = response.json()

            if data.get("error"):
                logger.warning("Error polling %s: %s", endpoint, data["error"])
                return 0

            posts = data.get("result", {}).get("posts", [])
        except Exception:
            logger.exception("Failed to poll subscription %s", sub["id"])
            return 0

        count = 0
        for post in posts:
            # Ingest as KnowledgeEntry
            entry = KnowledgeEntry(
                agent_id=sub["agent_id"],
                interest_id=f"network:{sub['remote_agent_id']}",
                title=post.get("title", ""),
                summary=post.get("summary", ""),
                sources=post.get("sources", []),
                relevance=0.5,
                novelty=0.8,
            )
            await self.store.save_knowledge_entry(entry)

            # Create FeedItem with network origin and agent attribution
            feed_item = FeedItem(
                agent_id=sub["agent_id"],
                entry_id=entry.id,
                headline=post.get("title", ""),
                body=post.get("summary", ""),
                topic_path=post.get("topic_path", ""),
                source_origin="network",
                source_agent_id=sub["remote_agent_id"],
                source_agent_name=sub.get("remote_agent_name", ""),
            )
            await self.store.save_feed_item(feed_item)
            count += 1

        # Update last polled
        await self.store.update_subscription_polled(
            sub["id"], datetime.now(timezone.utc).isoformat()
        )
        logger.info("Polled %s: %d new posts", sub["remote_agent_id"][:8], count)
        return count

    async def auto_discover(self, agent_id: str, registry) -> list:
        """Scan registry for agents with overlapping interest tags."""
        interests = await self.store.list_interests(agent_id)
        suggestions = []
        seen = set()

        for interest in interests:
            # Search by topic path segments
            for segment in interest.path.split("/"):
                cards = registry.discover_by_topic(segment)
                for card in cards:
                    if card.id not in seen and card.id != agent_id:
                        seen.add(card.id)
                        suggestions.append(card)

        return suggestions

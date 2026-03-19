"""EngagementTracker — records and analyzes user engagement with feed items."""

import uuid
from datetime import datetime, timedelta, timezone

from youagent.knowledge.store import KnowledgeStore


class EngagementTracker:
    # Threshold: if engagement with a followed agent drops below this for 7 days, soft-unfollow
    SOFT_UNFOLLOW_THRESHOLD = 0.05
    SOFT_UNFOLLOW_DAYS = 7

    def __init__(self, store: KnowledgeStore) -> None:
        self.store = store

    async def record_event(
        self,
        agent_id: str,
        feed_item_id: str,
        event_type: str,
        metadata: dict = None,
    ) -> None:
        """Record an engagement event. event_type: click, skip, dismiss, ask_followup."""
        event = {
            "id": str(uuid.uuid4()),
            "agent_id": agent_id,
            "feed_item_id": feed_item_id,
            "event_type": event_type,
            "metadata": metadata or {},
            "created_at": datetime.now(timezone.utc).isoformat(),
        }
        await self.store.save_engagement(event)

    async def get_source_trust(self, agent_id: str, domain_or_agent: str) -> float:
        """Ratio of clicked items from a domain or remote agent."""
        since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        events = await self.store.get_engagements_since(agent_id, since)

        total = 0
        clicks = 0
        for event in events:
            meta = event.get("metadata", {})
            source = meta.get("source", "") or meta.get("remote_agent", "")
            if domain_or_agent.lower() in source.lower():
                total += 1
                if event["event_type"] == "click":
                    clicks += 1

        return clicks / max(total, 1)

    async def get_topic_affinity(self, agent_id: str, topic_path: str) -> float:
        """Engagement-weighted score for a topic path, with time decay."""
        since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        events = await self.store.get_engagements_since(agent_id, since)

        total = 0
        clicks = 0
        for event in events:
            meta = event.get("metadata", {})
            if meta.get("topic_path", "").startswith(topic_path):
                total += 1
                if event["event_type"] == "click":
                    clicks += 1

        return clicks / max(total, 1)

    async def check_soft_unfollows(self, agent_id: str) -> list[str]:
        """Returns subscription IDs that should be soft-unfollowed due to low engagement."""
        since = (
            datetime.now(timezone.utc) - timedelta(days=self.SOFT_UNFOLLOW_DAYS)
        ).isoformat()

        subs = await self.store.get_subscriptions(agent_id)
        events = await self.store.get_engagements_since(agent_id, since)

        # Count engagement per remote agent
        remote_engagement: dict[str, dict] = {}
        for event in events:
            meta = event.get("metadata", {})
            remote_id = meta.get("remote_agent_id")
            if remote_id:
                if remote_id not in remote_engagement:
                    remote_engagement[remote_id] = {"total": 0, "clicks": 0}
                remote_engagement[remote_id]["total"] += 1
                if event["event_type"] == "click":
                    remote_engagement[remote_id]["clicks"] += 1

        to_unfollow = []
        for sub in subs:
            remote_id = sub["remote_agent_id"]
            stats = remote_engagement.get(remote_id, {"total": 0, "clicks": 0})
            if stats["total"] > 5:  # Need enough data points
                ratio = stats["clicks"] / stats["total"]
                if ratio < self.SOFT_UNFOLLOW_THRESHOLD:
                    to_unfollow.append(sub["id"])
                    await self.store.set_subscription_active(sub["id"], False)

        return to_unfollow

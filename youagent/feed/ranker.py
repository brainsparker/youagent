"""TimelineRanker — scores and ranks feed items for the timeline view."""

import math
from datetime import datetime, timezone
from urllib.parse import urlparse

from youagent.knowledge.store import KnowledgeStore
from youagent.models.knowledge import FeedItem


class TimelineRanker:
    def __init__(self, store: KnowledgeStore) -> None:
        self.store = store
        self._source_trust_cache: dict[str, float] = {}
        self._topic_affinity_cache: dict[str, float] = {}

    async def rank(self, items: list[FeedItem], agent_id: str) -> list[FeedItem]:
        """Rank feed items by combined score."""
        if not items:
            return items

        # Pre-load engagement data
        await self._load_engagement_data(agent_id)

        scored = []
        now = datetime.now(timezone.utc)
        for item in items:
            score = self._score_item(item, now)
            scored.append((score, item))

        scored.sort(key=lambda x: x[0], reverse=True)
        return [item for _, item in scored]

    def _score_item(self, item: FeedItem, now: datetime) -> float:
        relevance = self._relevance_score(item)
        novelty = self._novelty_score(item)
        source_trust = self._source_trust_score(item)
        topic_affinity = self._topic_affinity_score(item)
        recency = self._recency_score(item, now)

        return (
            0.3 * relevance
            + 0.2 * novelty
            + 0.2 * source_trust
            + 0.2 * topic_affinity
            + 0.1 * recency
        )

    def _relevance_score(self, item: FeedItem) -> float:
        # Network items get a small boost for novelty
        if item.source_origin == "network":
            return 0.7
        return 0.5

    def _novelty_score(self, item: FeedItem) -> float:
        # Unread items are more novel
        return 0.8 if not item.read else 0.2

    def _source_trust_score(self, item: FeedItem) -> float:
        # Check cached trust for the source origin / domain
        key = item.source_origin
        return self._source_trust_cache.get(key, 0.5)

    def _topic_affinity_score(self, item: FeedItem) -> float:
        return self._topic_affinity_cache.get(item.topic_path, 0.5)

    def _recency_score(self, item: FeedItem, now: datetime) -> float:
        try:
            created = item.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=timezone.utc)
            age_hours = (now - created).total_seconds() / 3600
            # Exponential decay: half-life of 24 hours
            return math.exp(-0.029 * age_hours)
        except Exception:
            return 0.5

    async def _load_engagement_data(self, agent_id: str) -> None:
        """Load engagement stats to populate trust and affinity caches."""
        from datetime import timedelta
        since = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()

        try:
            events = await self.store.get_engagements_since(agent_id, since)
        except Exception:
            return

        # Count clicks per source_origin and topic
        origin_clicks: dict[str, int] = {}
        origin_total: dict[str, int] = {}
        topic_clicks: dict[str, int] = {}
        topic_total: dict[str, int] = {}

        for event in events:
            meta = event.get("metadata", {})
            origin = meta.get("source_origin", "search")
            topic = meta.get("topic_path", "")

            origin_total[origin] = origin_total.get(origin, 0) + 1
            topic_total[topic] = topic_total.get(topic, 0) + 1

            if event["event_type"] == "click":
                origin_clicks[origin] = origin_clicks.get(origin, 0) + 1
                topic_clicks[topic] = topic_clicks.get(topic, 0) + 1

        for origin, total in origin_total.items():
            clicks = origin_clicks.get(origin, 0)
            self._source_trust_cache[origin] = min(1.0, clicks / max(total, 1))

        for topic, total in topic_total.items():
            clicks = topic_clicks.get(topic, 0)
            self._topic_affinity_cache[topic] = min(1.0, clicks / max(total, 1))

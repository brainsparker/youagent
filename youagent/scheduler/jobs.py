import logging
import uuid
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

from youagent.knowledge.dedup import compute_novelty, compute_relevance, is_duplicate_url
from youagent.knowledge.store import KnowledgeStore
from youagent.models.interest import Interest
from youagent.models.knowledge import FeedItem, KnowledgeEntry, Source
from youagent.search.client import YouSearchClient

logger = logging.getLogger(__name__)


async def run_search_for_interest(
    agent_id: str,
    interest: Interest,
    client: YouSearchClient,
    store: KnowledgeStore,
) -> int:
    queries = interest.queries or [interest.path.replace("/", " ")]
    all_search_results = []

    for query in queries:
        results = await client.search(query)
        all_search_results.extend(results)

    # Gather existing URLs for dedup
    existing_urls: set[str] = set()
    existing_entries = await store.get_entries(agent_id, limit=500)
    for entry in existing_entries:
        existing_urls.update(entry.sources)

    new_count = 0
    for result in all_search_results:
        if is_duplicate_url(result.url, existing_urls):
            continue

        relevance = compute_relevance(
            text=f"{result.title} {result.description} {' '.join(result.snippets)}",
            queries=interest.queries,
            taxonomy_path=interest.path,
        )
        novelty = compute_novelty(result.url, existing_urls)

        # Save source
        domain = urlparse(result.url).netloc
        source = Source(url=result.url, title=result.title, domain=domain)
        await store.save_source(source)
        existing_urls.add(result.url)

        # Get AI synthesis via Research API
        research_query = f"{interest.path.replace('/', ' ')}: {result.title}"
        try:
            research = await client.research(research_query)
            summary = research.answer
        except Exception:
            summary = result.description

        # Save knowledge entry
        entry = KnowledgeEntry(
            agent_id=agent_id,
            interest_id=interest.id,
            title=result.title,
            summary=summary,
            raw_content=result.description,
            sources=[result.url],
            relevance=relevance,
            novelty=novelty,
        )
        await store.save_knowledge_entry(entry)

        # Create feed item
        source_link = f"[{domain}]({result.url})"
        feed_item = FeedItem(
            agent_id=agent_id,
            entry_id=entry.id,
            headline=result.title,
            body=f"{summary}\n\nSource: {source_link}",
            topic_path=interest.path,
        )
        await store.save_feed_item(feed_item)

        # Publish as post for followers (Phase 2)
        await store.save_post({
            "id": str(uuid.uuid4()),
            "agent_id": agent_id,
            "entry_id": entry.id,
            "title": result.title,
            "summary": summary,
            "sources": [result.url],
            "topic_path": interest.path,
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

        new_count += 1

    # Update last polled
    await store.update_last_polled(interest.id, datetime.now(timezone.utc).isoformat())

    return new_count


async def run_synthesis_for_agent(agent_id: str, engine) -> Optional[str]:
    """Run intelligence synthesis for an agent. Returns briefing ID or None."""
    try:
        briefing = await engine.generate_briefing(agent_id)
        if briefing:
            logger.info("Synthesis complete for agent %s: briefing %s", agent_id, briefing.id)
            return briefing.id
        return None
    except Exception:
        logger.exception("Synthesis failed for agent %s", agent_id)
        return None


async def run_entity_extraction(entry: KnowledgeEntry, store: KnowledgeStore, llm_client) -> int:
    """Extract entities from a knowledge entry. Returns entity count."""
    if not llm_client:
        return 0
    try:
        from youagent.graph.extractor import EntityExtractor
        extractor = EntityExtractor(store, llm_client)
        return await extractor.extract_from_entry(entry)
    except Exception:
        logger.exception("Entity extraction failed for entry %s", entry.id)
        return 0


async def run_auto_discover(agent_id: str, store: KnowledgeStore, a2a_client, registry) -> list:
    """Scan registry for agents with overlapping interests. Returns suggestions."""
    from youagent.network.follower import NetworkFollower

    follower = NetworkFollower(store, a2a_client)
    try:
        suggestions = await follower.auto_discover(agent_id, registry)
        if suggestions:
            logger.info("Auto-discover found %d suggestions for agent %s", len(suggestions), agent_id[:8])
        return suggestions
    except Exception:
        logger.exception("Auto-discover failed for agent %s", agent_id)
        return []


async def run_network_poll(subscription: dict, store: KnowledgeStore, a2a_client) -> int:
    """Poll a followed agent for new posts. Returns count of new items."""
    from youagent.network.follower import NetworkFollower

    follower = NetworkFollower(store, a2a_client)
    try:
        return await follower.poll_subscription(subscription)
    except Exception:
        logger.exception("Network poll failed for subscription %s", subscription["id"])
        return 0

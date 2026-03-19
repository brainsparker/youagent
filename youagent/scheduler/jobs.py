from datetime import datetime, timezone
from urllib.parse import urlparse

from youagent.knowledge.dedup import compute_novelty, compute_relevance, is_duplicate_url
from youagent.knowledge.store import KnowledgeStore
from youagent.models.interest import Interest
from youagent.models.knowledge import FeedItem, KnowledgeEntry, Source
from youagent.search.client import YouSearchClient


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
        new_count += 1

    # Update last polled
    await store.update_last_polled(interest.id, datetime.now(timezone.utc).isoformat())

    return new_count

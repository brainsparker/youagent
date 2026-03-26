"""RespondEngine — deeper investigation on a timeline item, publishes a new post."""

import json
import logging
import uuid
from datetime import datetime, timezone

from youagent.knowledge.store import KnowledgeStore
from youagent.models.knowledge import FeedItem, KnowledgeEntry
from youagent.respond.prompts import RESPOND_QUERY_PROMPT, RESPOND_SYNTHESIS_PROMPT
from youagent.search.client import YouSearchClient

logger = logging.getLogger(__name__)


class RespondEngine:
    def __init__(self, store: KnowledgeStore, search_client: YouSearchClient, llm_client) -> None:
        self.store = store
        self.search_client = search_client
        self.llm_client = llm_client

    async def respond(self, agent_id: str, feed_item_id: str) -> dict:
        """Run deeper investigation on a feed item and publish a response post.

        Returns dict with post_id, feed_item_id, entry_id, title, summary.
        """
        # 1. Load original item
        item = await self.store.get_feed_item(feed_item_id)
        if not item:
            raise ValueError(f"Feed item not found: {feed_item_id}")

        # 2. Load linked knowledge entry
        entry = await self.store.get_entry(item.entry_id)
        original_title = item.headline
        original_summary = entry.summary if entry else item.body

        # 3. Generate deeper search queries via LLM
        query_prompt = RESPOND_QUERY_PROMPT.format(
            title=original_title,
            summary=original_summary,
        )
        queries_raw = await self.llm_client.complete(
            "You are a research assistant. Output only valid JSON.",
            query_prompt,
        )
        try:
            queries = json.loads(queries_raw.strip())
            if not isinstance(queries, list):
                queries = [queries_raw.strip()]
        except json.JSONDecodeError:
            queries = [f"{original_title} deep dive", f"{original_title} competitors funding"]

        # 4. Execute searches
        research_results = []
        for query in queries[:5]:
            try:
                research = await self.search_client.research(query)
                research_results.append(f"Query: {query}\nAnswer: {research.answer}\n")
            except Exception:
                try:
                    results = await self.search_client.search(query, num_results=3)
                    for r in results:
                        research_results.append(f"Query: {query}\nTitle: {r.title}\nDescription: {r.description}\n")
                except Exception:
                    logger.warning("Search failed for query: %s", query)

        if not research_results:
            raise RuntimeError("All research queries failed — cannot generate response")

        # 5. LLM synthesis
        synthesis_prompt = RESPOND_SYNTHESIS_PROMPT.format(
            original_title=original_title,
            original_summary=original_summary,
            research_results="\n---\n".join(research_results),
        )
        synthesis_raw = await self.llm_client.complete(
            "You are an intelligence analyst. Output only valid JSON.",
            synthesis_prompt,
        )
        try:
            synthesis = json.loads(synthesis_raw.strip())
        except json.JSONDecodeError:
            # Try extracting JSON from the response
            start = synthesis_raw.find("{")
            end = synthesis_raw.rfind("}") + 1
            if start >= 0 and end > start:
                synthesis = json.loads(synthesis_raw[start:end])
            else:
                synthesis = {
                    "title": f"Analysis: {original_title}",
                    "summary": synthesis_raw,
                }

        new_title = synthesis.get("title", f"Analysis: {original_title}")
        new_summary = synthesis.get("summary", "")

        # 6. Save new KnowledgeEntry
        new_entry = KnowledgeEntry(
            agent_id=agent_id,
            interest_id=f"respond:{feed_item_id}",
            title=new_title,
            summary=new_summary,
            raw_content="\n---\n".join(research_results),
            sources=entry.sources if entry else [],
            relevance=0.9,
            novelty=0.9,
        )
        await self.store.save_knowledge_entry(new_entry)

        # 7. Save new FeedItem
        source_agent_name = item.source_agent_name
        body_prefix = ""
        if source_agent_name:
            body_prefix = f"Responding to @{source_agent_name}'s finding about {original_title}\n\n"
        elif item.source_origin == "network":
            body_prefix = f"Responding to a network finding about {original_title}\n\n"

        new_feed_item = FeedItem(
            agent_id=agent_id,
            entry_id=new_entry.id,
            headline=new_title,
            body=body_prefix + new_summary,
            topic_path=item.topic_path,
            source_origin="respond",
            parent_post_id=feed_item_id,
        )
        await self.store.save_feed_item(new_feed_item)

        # 8. Save new Post
        post_id = str(uuid.uuid4())
        await self.store.save_post({
            "id": post_id,
            "agent_id": agent_id,
            "entry_id": new_entry.id,
            "title": new_title,
            "summary": new_summary,
            "sources": entry.sources if entry else [],
            "topic_path": item.topic_path,
            "created_at": datetime.now(timezone.utc).isoformat(),
            "parent_post_id": feed_item_id,
        })

        # 9. Record engagement event
        await self.store.save_engagement({
            "id": str(uuid.uuid4()),
            "agent_id": agent_id,
            "feed_item_id": feed_item_id,
            "event_type": "respond",
            "metadata": {"response_post_id": post_id},
            "created_at": datetime.now(timezone.utc).isoformat(),
        })

        return {
            "post_id": post_id,
            "feed_item_id": new_feed_item.id,
            "entry_id": new_entry.id,
            "title": new_title,
            "summary": new_summary,
        }

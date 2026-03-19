"""Core synthesis orchestrator — generates intelligence briefings from recent entries."""

import logging
from datetime import datetime, timedelta, timezone
from typing import Optional

from youagent.knowledge.store import KnowledgeStore
from youagent.models.briefing import Briefing
from youagent.synthesis.llm_client import LLMClient
from youagent.synthesis.prompts import build_synthesis_prompt, parse_briefing_response

logger = logging.getLogger(__name__)


class SynthesisEngine:
    def __init__(
        self,
        store: KnowledgeStore,
        llm_client: Optional[LLMClient] = None,
    ) -> None:
        self.store = store
        self.llm_client = llm_client

    async def generate_briefing(self, agent_id: str) -> Optional[Briefing]:
        if not self.llm_client:
            logger.debug("No LLM client configured — skipping synthesis")
            return None

        # Get agent info
        agent = await self.store.get_agent(agent_id)
        if not agent:
            logger.warning("Agent %s not found", agent_id)
            return None

        # Get previous briefing for temporal context
        previous = await self.store.get_latest_briefing(agent_id)
        previous_summary = None
        if previous:
            for section in previous.sections:
                if section.kind == "executive_summary":
                    previous_summary = section.content
                    break

        # Get entries since last briefing (or last 24h)
        if previous:
            since = previous.created_at
        else:
            since = datetime.now(timezone.utc) - timedelta(hours=24)

        entries = await self.store.get_entries_since(agent_id, since)
        if not entries:
            logger.debug("No new entries since last briefing — skipping")
            return None

        # Get agent's topic interests
        interests = await self.store.list_interests(agent_id)
        topics = [i.path for i in interests]

        # Gather entity context for richer briefings
        entity_context = await self._get_entity_context(entries)

        # Build and send prompt
        system_prompt, user_prompt = build_synthesis_prompt(
            agent_name=agent.name,
            topics=topics,
            entries=entries,
            previous_summary=previous_summary,
            entity_context=entity_context,
        )

        try:
            raw_response = await self.llm_client.complete(system_prompt, user_prompt)
            sections = parse_briefing_response(raw_response)
        except Exception:
            logger.exception("LLM synthesis failed")
            return None

        # Build and save briefing
        briefing = Briefing(
            agent_id=agent_id,
            sections=sections,
            entry_ids=[e.id for e in entries],
            previous_briefing_id=previous.id if previous else None,
            llm_provider=self.llm_client.provider.value,
            llm_model=self.llm_client.model,
        )
        await self.store.save_briefing(briefing)
        logger.info("Generated briefing %s for agent %s (%d entries)", briefing.id, agent_id, len(entries))
        return briefing

    async def _get_entity_context(self, entries: list) -> str:
        """Build entity context string from entries for richer briefings."""
        entity_names = set()
        for entry in entries:
            # Check if entries have linked entities
            try:
                # Use a simple keyword approach to find entities
                entity = await self.store.find_entity(entry.title.split()[0] if entry.title else "")
                if entity:
                    entity_names.add(entity["name"])
                    # Get related entities
                    relations = await self.store.get_related_entities(entity["id"])
                    for rel in relations[:3]:
                        entity_names.add(rel["entity_name"])
            except Exception:
                continue

        if entity_names:
            return f"Key entities mentioned: {', '.join(sorted(entity_names))}"
        return ""

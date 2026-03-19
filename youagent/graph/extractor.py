"""EntityExtractor — uses LLM to extract entities and relations from knowledge entries."""

import json
import logging
import re
import uuid

from youagent.graph.prompts import build_entity_prompt
from youagent.knowledge.store import KnowledgeStore
from youagent.models.knowledge import KnowledgeEntry
from youagent.synthesis.llm_client import LLMClient

logger = logging.getLogger(__name__)


class EntityExtractor:
    def __init__(self, store: KnowledgeStore, llm_client: LLMClient) -> None:
        self.store = store
        self.llm_client = llm_client

    async def extract_from_entry(self, entry: KnowledgeEntry) -> int:
        """Extract entities from a knowledge entry. Returns count of entities found."""
        system_prompt, user_prompt = build_entity_prompt(entry.title, entry.summary)

        try:
            raw = await self.llm_client.complete(system_prompt, user_prompt)
        except Exception:
            logger.exception("LLM entity extraction failed for entry %s", entry.id)
            return 0

        # Parse response
        cleaned = raw.strip()
        cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```\s*$", "", cleaned)
        cleaned = cleaned.strip()

        try:
            data = json.loads(cleaned)
        except json.JSONDecodeError:
            logger.warning("Failed to parse entity extraction JSON for entry %s", entry.id)
            return 0

        # Save entities
        entity_name_to_id = {}
        entities = data.get("entities", [])
        for ent in entities:
            name = ent.get("name", "").strip()
            if not name:
                continue

            # Check if entity already exists
            existing = await self.store.find_entity(name)
            if existing:
                entity_name_to_id[name] = existing["id"]
            else:
                entity_id = str(uuid.uuid4())
                await self.store.save_entity({
                    "id": entity_id,
                    "name": name,
                    "type": ent.get("type", "unknown"),
                    "aliases": ent.get("aliases", []),
                    "mention_count": 1,
                })
                entity_name_to_id[name] = entity_id

            # Link entry to entity
            await self.store.link_entry_entity(entry.id, entity_name_to_id[name])

        # Save relations
        relations = data.get("relations", [])
        for rel in relations:
            source_name = rel.get("source", "")
            target_name = rel.get("target", "")
            source_id = entity_name_to_id.get(source_name)
            target_id = entity_name_to_id.get(target_name)

            if source_id and target_id:
                await self.store.save_entity_relation({
                    "id": str(uuid.uuid4()),
                    "source_entity_id": source_id,
                    "target_entity_id": target_id,
                    "relation_type": rel.get("type", "related_to"),
                    "entry_id": entry.id,
                })

        logger.debug("Extracted %d entities from entry %s", len(entities), entry.id[:8])
        return len(entities)

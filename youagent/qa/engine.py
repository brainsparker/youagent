"""QAEngine — answers questions using accumulated local + network knowledge."""

import logging
import re

from youagent.knowledge.store import KnowledgeStore
from youagent.qa.models import QAResponse
from youagent.qa.prompts import build_qa_prompt
from youagent.synthesis.llm_client import LLMClient

logger = logging.getLogger(__name__)


class QAEngine:
    def __init__(self, store: KnowledgeStore, llm_client: LLMClient) -> None:
        self.store = store
        self.llm_client = llm_client

    async def answer(self, agent_id: str, question: str) -> QAResponse:
        """Answer a question using local entries + network posts."""
        # Step 1: Extract keywords
        keywords = self._extract_keywords(question)

        # Step 2: Search local entries
        entries = await self.store.search_entries(agent_id, keywords, limit=15)

        # Step 3: Search network posts
        posts = await self.store.search_posts(keywords, limit=10)

        # Step 4: Check entity-linked entries (Phase 5 enhancement)
        entity_entries = await self._get_entity_entries(keywords)
        # Merge without duplicates
        seen_ids = {e.id for e in entries}
        for e in entity_entries:
            if e.id not in seen_ids:
                entries.append(e)
                seen_ids.add(e.id)

        if not entries and not posts:
            return QAResponse(
                answer="I don't have enough information in my knowledge base to answer this question. Try running a search first.",
                confidence="low",
                entries_used=0,
            )

        # Step 5: Build LLM prompt
        system_prompt, user_prompt = build_qa_prompt(question, entries, posts)

        # Step 6: Call LLM
        try:
            raw = await self.llm_client.complete(system_prompt, user_prompt)
        except Exception:
            logger.exception("LLM call failed during Q&A")
            return QAResponse(
                answer="Sorry, the LLM call failed. Please try again.",
                confidence="low",
                entries_used=len(entries),
            )

        # Step 7: Parse response
        return self._parse_response(raw, entries, posts)

    def _extract_keywords(self, question: str) -> list[str]:
        """Extract meaningful keywords from a question."""
        # Remove common question words
        stop_words = {
            "what", "when", "where", "who", "why", "how", "is", "are", "was",
            "were", "do", "does", "did", "the", "a", "an", "in", "on", "at",
            "to", "for", "of", "with", "by", "from", "about", "my", "me",
            "show", "tell", "find", "get", "give", "know", "everything",
            "anything", "something", "network", "knows", "latest", "recent",
        }
        words = re.findall(r'\b[a-zA-Z]{2,}\b', question.lower())
        keywords = [w for w in words if w not in stop_words]
        return keywords or words[:3]  # Fallback to first 3 words

    async def _get_entity_entries(self, keywords: list[str]) -> list:
        """If any keyword matches a known entity, get linked entries."""
        entries = []
        for kw in keywords:
            entity = await self.store.find_entity(kw)
            if entity:
                linked = await self.store.get_entity_entries(entity["id"], limit=5)
                entries.extend(linked)
        return entries

    def _parse_response(self, raw: str, entries: list, posts: list) -> QAResponse:
        """Parse LLM response into QAResponse."""
        # Extract confidence
        confidence = "medium"
        confidence_match = re.search(r'[Cc]onfidence:\s*(high|medium|low)', raw)
        if confidence_match:
            confidence = confidence_match.group(1)

        # Remove confidence line from answer
        answer = re.sub(r'\n*[Cc]onfidence:\s*(high|medium|low)\s*$', '', raw).strip()

        # Extract source URLs mentioned in the answer
        sources = []
        for entry in entries:
            for src in entry.sources:
                if src in answer:
                    sources.append(src)
        for post in posts:
            for src in post.get("sources", []):
                if src in answer:
                    sources.append(src)

        # Also collect all sources for reference
        if not sources:
            for entry in entries[:5]:
                sources.extend(entry.sources)
            for post in posts[:3]:
                sources.extend(post.get("sources", []))

        return QAResponse(
            answer=answer,
            sources=list(dict.fromkeys(sources))[:10],  # Deduplicate, limit
            confidence=confidence,
            entries_used=len(entries) + len(posts),
        )

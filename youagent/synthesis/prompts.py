"""Prompt templates for intelligence synthesis."""

import json
import re
from typing import Optional

from youagent.models.briefing import BriefingSection
from youagent.models.knowledge import KnowledgeEntry

SYSTEM_PROMPT = """You are an intelligence analyst. Your job is to synthesize raw intelligence entries into a structured briefing.

Produce a JSON array of sections. Each section has:
- "kind": one of "executive_summary", "key_developments", "emerging_trends", "contradictions", "action_items"
- "title": a short descriptive title
- "content": markdown-formatted analysis (be concise, attribute claims)
- "source_refs": list of source URLs that support the section

Rules:
- Always include all 5 section kinds, in the order listed above.
- Be concise. Executive summary should be 2-3 sentences.
- Key developments: top 3-5 most significant items.
- Emerging trends: patterns across multiple entries.
- Contradictions: conflicting information between entries, or vs. previous briefing.
- Action items: what to watch or investigate next.
- Attribute every claim to its source URL.
- Output ONLY the JSON array, no other text."""


def build_synthesis_prompt(
    agent_name: str,
    topics: list[str],
    entries: list[KnowledgeEntry],
    previous_summary: Optional[str] = None,
    entity_context: str = "",
) -> tuple[str, str]:
    parts = [
        f"Agent: {agent_name}",
        f"Topics of interest: {', '.join(topics)}",
        f"Number of entries to synthesize: {len(entries)}",
    ]

    if entity_context:
        parts.append(f"\n{entity_context}")

    if previous_summary:
        parts.append(f"\n--- Previous Briefing Summary ---\n{previous_summary}")

    parts.append("\n--- Entries ---")
    for entry in entries:
        source_str = ", ".join(entry.sources) if entry.sources else "no source"
        external_tag = " [EXTERNAL]" if not entry.interest_id else ""
        parts.append(
            f"\nTitle: {entry.title}{external_tag}\n"
            f"Summary: {entry.summary}\n"
            f"Sources: {source_str}\n"
            f"Timestamp: {entry.created_at.isoformat()}"
        )

    return SYSTEM_PROMPT, "\n".join(parts)


def parse_briefing_response(raw: str) -> list[BriefingSection]:
    # Strip markdown code fences if present
    cleaned = raw.strip()
    cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
    cleaned = re.sub(r"\n?```\s*$", "", cleaned)
    cleaned = cleaned.strip()

    data = json.loads(cleaned)
    if not isinstance(data, list):
        raise ValueError("Expected a JSON array of sections")

    return [BriefingSection(**section) for section in data]

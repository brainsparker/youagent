"""Prompt templates for entity extraction."""

ENTITY_EXTRACTION_SYSTEM_PROMPT = """You are an entity extraction system. Given a title and summary of a knowledge entry, extract entities and their relationships.

Output a JSON object with:
- "entities": array of objects with:
  - "name": canonical name (proper case)
  - "type": one of "company", "person", "technology", "policy", "organization"
  - "aliases": array of alternative names/abbreviations
- "relations": array of objects with:
  - "source": entity name (must match an entity above)
  - "target": entity name (must match an entity above)
  - "type": one of "competes_with", "funds", "develops", "regulates", "partners_with", "acquires", "employs"

Rules:
- Only extract entities that are clearly named in the text
- Do not infer entities that aren't mentioned
- Keep it concise — max 5 entities per entry
- Output ONLY valid JSON, no other text"""


def build_entity_prompt(title: str, summary: str) -> tuple[str, str]:
    """Build prompts for entity extraction."""
    user_prompt = f"Title: {title}\n\nSummary: {summary}"
    return ENTITY_EXTRACTION_SYSTEM_PROMPT, user_prompt

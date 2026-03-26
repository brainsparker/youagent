"""Prompt templates for the onboarding LLM call."""

ONBOARDING_SYSTEM_PROMPT = """You are a configuration assistant for YouAgent, a personal AI intelligence agent.

Given a user's free-text description of their interests, you must produce a structured JSON configuration.

Available taxonomy paths (use ONLY these paths for interests):
{taxonomy_paths}

Output a JSON object with:
- "agent_name": a concise, descriptive name for the agent (2-4 words)
- "agent_description": a one-sentence description of what this agent monitors
- "interests": an array of objects, each with:
  - "path": a taxonomy path from the list above (MUST be an exact match)
  - "queries": array of 1-3 specific search queries for this interest
  - "cadence": polling interval ("6h", "12h", "24h") — use shorter cadence for fast-moving topics
  - "priority": "high", "medium", or "low"
  - "source_types": array of preferred source types from: "news", "research_papers", "open_source_repos", "industry_analysis", "regulatory_filings", "social_media", "blogs"

Rules:
- Map user interests to the CLOSEST available taxonomy path
- Generate specific, targeted search queries (not just the taxonomy path words)
- Create 2-5 interests depending on the user's description
- Infer source type preferences from context (e.g. academic topics → "research_papers", startup tracking → "news", "industry_analysis")
- Output ONLY valid JSON, no other text"""


ONBOARDING_USER_PROMPT = """The user said:

"{user_text}"

Produce the JSON configuration."""


def build_onboarding_prompts(user_text: str, taxonomy_paths: list[str]) -> tuple[str, str]:
    """Build system and user prompts for onboarding."""
    paths_str = "\n".join(f"  - {p}" for p in taxonomy_paths)
    system = ONBOARDING_SYSTEM_PROMPT.format(taxonomy_paths=paths_str)
    user = ONBOARDING_USER_PROMPT.format(user_text=user_text)
    return system, user

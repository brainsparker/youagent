"""OnboardingParser — parses free-text user input into agent configuration via LLM."""

import json
import logging
import re
from typing import Optional

from youagent.onboarding.models import OnboardingInterest, OnboardingResult
from youagent.onboarding.prompts import build_onboarding_prompts
from youagent.synthesis.llm_client import LLMClient
from youagent.taxonomy.tree import TaxonomyTree

logger = logging.getLogger(__name__)


class OnboardingParser:
    def __init__(self, taxonomy: TaxonomyTree) -> None:
        self.taxonomy = taxonomy

    async def parse(self, user_text: str, llm_client: LLMClient) -> OnboardingResult:
        """Parse free-text user input into an OnboardingResult via LLM."""
        leaf_paths = self.taxonomy.all_leaf_paths()
        system_prompt, user_prompt = build_onboarding_prompts(user_text, leaf_paths)

        raw = await llm_client.complete(system_prompt, user_prompt)

        # Strip markdown code fences if present
        cleaned = raw.strip()
        cleaned = re.sub(r"^```(?:json)?\s*\n?", "", cleaned)
        cleaned = re.sub(r"\n?```\s*$", "", cleaned)
        cleaned = cleaned.strip()

        data = json.loads(cleaned)

        # Validate and fix taxonomy paths
        interests = []
        for item in data.get("interests", []):
            path = item.get("path", "")
            if not self.taxonomy.contains(path):
                # Fuzzy fallback
                matches = self.taxonomy.search(path.split("/")[-1] if "/" in path else path)
                if matches:
                    path = matches[0]
                    logger.info("Remapped invalid path %r to %r", item["path"], path)
                else:
                    logger.warning("Skipping unmappable path: %s", item["path"])
                    continue

            interests.append(OnboardingInterest(
                path=path,
                queries=item.get("queries", []),
                cadence=item.get("cadence", "24h"),
                priority=item.get("priority", "medium"),
            ))

        return OnboardingResult(
            agent_name=data.get("agent_name", "My Agent"),
            agent_description=data.get("agent_description", "Personal intelligence agent"),
            interests=interests,
        )

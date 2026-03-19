"""Agent discovery registry — track known agents and find by topic."""

import json
from pathlib import Path
from typing import Optional

from youagent.a2a.client import A2AClient
from youagent.a2a.models import A2AAgentCard


class AgentRegistry:
    def __init__(self, registry_path: Optional[Path] = None) -> None:
        self._agents: dict[str, A2AAgentCard] = {}
        self._registry_path = registry_path

        if registry_path and registry_path.exists():
            self._load()

    def register(self, card: A2AAgentCard) -> bool:
        """Add or update an agent in the registry."""
        self._agents[card.id] = card
        self._save()
        return True

    def unregister(self, agent_id: str) -> bool:
        if agent_id in self._agents:
            del self._agents[agent_id]
            self._save()
            return True
        return False

    def get(self, agent_id: str) -> Optional[A2AAgentCard]:
        return self._agents.get(agent_id)

    def list_agents(self) -> list[A2AAgentCard]:
        return list(self._agents.values())

    def discover_by_topic(self, taxonomy_path: str) -> list[A2AAgentCard]:
        """Find agents with skills matching the given taxonomy path."""
        matches = []
        path_lower = taxonomy_path.lower()
        for card in self._agents.values():
            for skill in card.skills:
                for tag in skill.tags:
                    if tag.lower().startswith(path_lower) or path_lower.startswith(tag.lower()):
                        matches.append(card)
                        break
                else:
                    continue
                break
        return matches

    async def discover_by_url(self, base_url: str) -> A2AAgentCard:
        """Fetch and register a remote agent's card."""
        client = A2AClient()
        try:
            card = await client.discover(base_url)
            self.register(card)
            return card
        finally:
            await client.close()

    def _save(self) -> None:
        if not self._registry_path:
            return
        self._registry_path.parent.mkdir(parents=True, exist_ok=True)
        data = [card.model_dump(by_alias=True) for card in self._agents.values()]
        self._registry_path.write_text(json.dumps(data, indent=2))

    def _load(self) -> None:
        if not self._registry_path or not self._registry_path.exists():
            return
        try:
            data = json.loads(self._registry_path.read_text())
            for card_data in data:
                card = A2AAgentCard.model_validate(card_data)
                self._agents[card.id] = card
        except (json.JSONDecodeError, Exception):
            pass

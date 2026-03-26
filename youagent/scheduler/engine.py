import asyncio
import logging
import re
import signal
from pathlib import Path
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from youagent.knowledge.store import KnowledgeStore
from youagent.models.interest import Interest
from youagent.scheduler.jobs import run_auto_discover, run_entity_extraction, run_network_poll, run_search_for_interest, run_synthesis_for_agent
from youagent.search.client import YouSearchClient
from youagent.synthesis.engine import SynthesisEngine
from youagent.synthesis.llm_client import create_llm_client

logger = logging.getLogger(__name__)


class SchedulerEngine:
    def __init__(self, api_key: str, db_path: Path, settings=None) -> None:
        self.api_key = api_key
        self.db_path = Path(db_path)
        self._settings = settings
        self._scheduler = AsyncIOScheduler()
        self._store: Optional[KnowledgeStore] = None
        self._client: Optional[YouSearchClient] = None
        self._synthesis_engine: Optional[SynthesisEngine] = None
        self._a2a_client = None

    def _parse_cadence(self, cadence: str) -> dict:
        match = re.match(r"^(\d+)([hmd])$", cadence)
        if not match:
            raise ValueError(f"Invalid cadence: {cadence}")
        value = int(match.group(1))
        unit = match.group(2)
        return {
            "h": {"hours": value},
            "m": {"minutes": value},
            "d": {"days": value},
        }[unit]

    async def setup(self) -> None:
        self._store = KnowledgeStore(self.db_path)
        await self._store.initialize()
        self._client = YouSearchClient(api_key=self.api_key)

        # Set up synthesis engine if LLM credentials available
        llm_client = create_llm_client(self._settings)
        if not llm_client:
            logger.info("No LLM credentials found — synthesis disabled")
        self._synthesis_engine = SynthesisEngine(self._store, llm_client)

        # Set up A2A client for network polling
        from youagent.a2a.client import A2AClient
        self._a2a_client = A2AClient()

        # Set up registry for auto-discovery
        from youagent.a2a.registry import AgentRegistry
        from youagent.config.defaults import YOUAGENT_HOME
        self._registry = AgentRegistry(registry_path=YOUAGENT_HOME / "registry.json")

    async def add_agent_jobs(self, agent_id: str) -> int:
        interests = await self._store.list_interests(agent_id)
        for interest in interests:
            interval = self._parse_cadence(interest.cadence)
            self._scheduler.add_job(
                self._run_job,
                "interval",
                kwargs={"agent_id": agent_id, "interest": interest},
                id=f"{agent_id}:{interest.id}",
                replace_existing=True,
                **interval,
            )

        # Add synthesis job if engine available
        if self._synthesis_engine and self._synthesis_engine.llm_client:
            cadence = "6h"
            if self._settings and hasattr(self._settings, "synthesis_cadence"):
                cadence = self._settings.synthesis_cadence
            interval = self._parse_cadence(cadence)
            self._scheduler.add_job(
                self._run_synthesis,
                "interval",
                kwargs={"agent_id": agent_id},
                id=f"{agent_id}:synthesis",
                replace_existing=True,
                **interval,
            )

        # Add network polling jobs for subscriptions
        subscriptions = await self._store.get_subscriptions(agent_id)
        for sub in subscriptions:
            interval = self._parse_cadence(sub.get("cadence", "6h"))
            self._scheduler.add_job(
                self._run_network_poll,
                "interval",
                kwargs={"subscription": sub},
                id=f"{agent_id}:network:{sub['id']}",
                replace_existing=True,
                **interval,
            )

        # Add auto-discovery job (every 24h)
        self._scheduler.add_job(
            self._run_auto_discover,
            "interval",
            kwargs={"agent_id": agent_id},
            id=f"{agent_id}:auto_discover",
            replace_existing=True,
            hours=24,
        )

        return len(interests)

    async def _run_auto_discover(self, agent_id: str) -> None:
        await run_auto_discover(agent_id, self._store, self._a2a_client, self._registry)

    async def _run_job(self, agent_id: str, interest: Interest) -> None:
        count = await run_search_for_interest(agent_id, interest, self._client, self._store)

        # Run entity extraction on new entries if LLM is available
        if count > 0 and self._synthesis_engine and self._synthesis_engine.llm_client:
            entries = await self._store.get_entries(agent_id, limit=count)
            for entry in entries:
                await run_entity_extraction(entry, self._store, self._synthesis_engine.llm_client)

    async def _run_synthesis(self, agent_id: str) -> None:
        await run_synthesis_for_agent(agent_id, self._synthesis_engine)

    async def _run_network_poll(self, subscription: dict) -> None:
        await run_network_poll(subscription, self._store, self._a2a_client)

    async def start(self) -> None:
        await self.setup()
        agents = await self._store.list_agents()
        for agent in agents:
            await self.add_agent_jobs(agent.id)
        self._scheduler.start()

    async def run_forever(self) -> None:
        await self.start()
        stop = asyncio.Event()

        def handle_signal(*_):
            stop.set()

        loop = asyncio.get_event_loop()
        for sig in (signal.SIGINT, signal.SIGTERM):
            loop.add_signal_handler(sig, handle_signal)

        await stop.wait()
        await self.shutdown()

    async def shutdown(self) -> None:
        self._scheduler.shutdown(wait=False)
        if self._synthesis_engine and self._synthesis_engine.llm_client:
            await self._synthesis_engine.llm_client.close()
        if self._a2a_client:
            await self._a2a_client.close()
        if self._client:
            await self._client.close()
        if self._store:
            await self._store.close()

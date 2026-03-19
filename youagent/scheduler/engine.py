import asyncio
import re
import signal
from pathlib import Path
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler

from youagent.knowledge.store import KnowledgeStore
from youagent.models.interest import Interest
from youagent.scheduler.jobs import run_search_for_interest
from youagent.search.client import YouSearchClient


class SchedulerEngine:
    def __init__(self, api_key: str, db_path: Path) -> None:
        self.api_key = api_key
        self.db_path = Path(db_path)
        self._scheduler = AsyncIOScheduler()
        self._store: Optional[KnowledgeStore] = None
        self._client: Optional[YouSearchClient] = None

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
        return len(interests)

    async def _run_job(self, agent_id: str, interest: Interest) -> None:
        await run_search_for_interest(agent_id, interest, self._client, self._store)

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
        if self._client:
            await self._client.close()
        if self._store:
            await self._store.close()

import json
from pathlib import Path
from typing import Optional

import aiosqlite

from youagent.models.agent import Agent
from youagent.models.card import AgentCard
from youagent.models.interest import Interest
from youagent.models.knowledge import FeedItem, KnowledgeEntry, Source

SCHEMA = """
CREATE TABLE IF NOT EXISTS agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL,
    card_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interests (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    queries TEXT,
    cadence TEXT NOT NULL,
    priority TEXT DEFAULT 'medium',
    last_polled TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_entries (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    interest_id TEXT,
    title TEXT,
    summary TEXT,
    raw_content TEXT,
    sources TEXT,
    relevance REAL,
    novelty REAL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sources (
    id TEXT PRIMARY KEY,
    url TEXT UNIQUE,
    title TEXT,
    domain TEXT,
    first_seen TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS feed_items (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    entry_id TEXT,
    headline TEXT,
    body TEXT,
    topic_path TEXT,
    created_at TEXT NOT NULL,
    read INTEGER DEFAULT 0
);
"""


class KnowledgeStore:
    def __init__(self, db_path: Path) -> None:
        self.db_path = db_path
        self._db: Optional[aiosqlite.Connection] = None

    async def initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self._db = await aiosqlite.connect(str(self.db_path))
        await self._db.executescript(SCHEMA)
        await self._db.execute("PRAGMA foreign_keys = ON")
        await self._db.commit()

    async def close(self) -> None:
        if self._db:
            await self._db.close()

    # --- Agents ---

    def _row_to_agent(self, row) -> Agent:
        card = AgentCard.model_validate_json(row[3])
        return Agent(
            id=row[0], name=row[1], description=row[2],
            card=card, created_at=row[4], updated_at=row[5],
        )

    async def save_agent(self, agent: Agent) -> None:
        card_json = agent.card.model_dump_json(by_alias=True)
        await self._db.execute(
            "INSERT OR REPLACE INTO agents (id, name, description, card_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
            (agent.id, agent.name, agent.description, card_json,
             agent.created_at.isoformat(), agent.updated_at.isoformat()),
        )
        await self._db.commit()

    async def get_agent(self, agent_id: str) -> Optional[Agent]:
        async with self._db.execute("SELECT * FROM agents WHERE id = ?", (agent_id,)) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return self._row_to_agent(row)

    async def list_agents(self) -> list[Agent]:
        agents = []
        async with self._db.execute("SELECT * FROM agents ORDER BY created_at") as cursor:
            async for row in cursor:
                agents.append(self._row_to_agent(row))
        return agents

    async def delete_agent(self, agent_id: str) -> None:
        await self._db.execute("DELETE FROM agents WHERE id = ?", (agent_id,))
        await self._db.commit()

    # --- Interests ---

    async def save_interest(self, agent_id: str, interest: Interest) -> None:
        queries_json = json.dumps(interest.queries) if interest.queries else None
        last_polled = interest.last_polled.isoformat() if interest.last_polled else None
        await self._db.execute(
            "INSERT OR REPLACE INTO interests (id, agent_id, path, queries, cadence, priority, last_polled) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (interest.id, agent_id, interest.path, queries_json,
             interest.cadence, interest.priority, last_polled),
        )
        await self._db.commit()

    async def list_interests(self, agent_id: str) -> list[Interest]:
        interests = []
        async with self._db.execute(
            "SELECT * FROM interests WHERE agent_id = ?", (agent_id,)
        ) as cursor:
            async for row in cursor:
                queries = json.loads(row[3]) if row[3] else None
                interests.append(Interest(
                    id=row[0], path=row[2], queries=queries,
                    cadence=row[4], priority=row[5],
                ))
        return interests

    async def delete_interest(self, interest_id: str) -> None:
        await self._db.execute("DELETE FROM interests WHERE id = ?", (interest_id,))
        await self._db.commit()

    # --- Knowledge Entries ---

    async def save_knowledge_entry(self, entry: KnowledgeEntry) -> None:
        sources_json = json.dumps(entry.sources)
        await self._db.execute(
            "INSERT INTO knowledge_entries (id, agent_id, interest_id, title, summary, raw_content, sources, relevance, novelty, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (entry.id, entry.agent_id, entry.interest_id, entry.title, entry.summary,
             entry.raw_content, sources_json, entry.relevance, entry.novelty,
             entry.created_at.isoformat()),
        )
        await self._db.commit()

    async def get_entries(self, agent_id: str, limit: int = 50) -> list[KnowledgeEntry]:
        entries = []
        async with self._db.execute(
            "SELECT * FROM knowledge_entries WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
            (agent_id, limit),
        ) as cursor:
            async for row in cursor:
                entries.append(KnowledgeEntry(
                    id=row[0], agent_id=row[1], interest_id=row[2],
                    title=row[3], summary=row[4], raw_content=row[5],
                    sources=json.loads(row[6]) if row[6] else [],
                    relevance=row[7], novelty=row[8], created_at=row[9],
                ))
        return entries

    # --- Sources ---

    async def save_source(self, source: Source) -> None:
        await self._db.execute(
            "INSERT OR IGNORE INTO sources (id, url, title, domain, first_seen) VALUES (?, ?, ?, ?, ?)",
            (source.id, source.url, source.title, source.domain, source.first_seen.isoformat()),
        )
        await self._db.commit()

    async def url_exists(self, url: str) -> bool:
        async with self._db.execute("SELECT 1 FROM sources WHERE url = ?", (url,)) as cursor:
            return await cursor.fetchone() is not None

    # --- Feed ---

    async def save_feed_item(self, item: FeedItem) -> None:
        await self._db.execute(
            "INSERT INTO feed_items (id, agent_id, entry_id, headline, body, topic_path, created_at, read) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (item.id, item.agent_id, item.entry_id, item.headline, item.body,
             item.topic_path, item.created_at.isoformat(), int(item.read)),
        )
        await self._db.commit()

    async def get_feed(
        self,
        agent_id: Optional[str] = None,
        topic: Optional[str] = None,
        unread_only: bool = False,
        limit: int = 50,
    ) -> list[FeedItem]:
        query = "SELECT * FROM feed_items WHERE 1=1"
        params: list = []
        if agent_id:
            query += " AND agent_id = ?"
            params.append(agent_id)
        if topic:
            query += " AND topic_path LIKE ?"
            params.append(f"{topic}%")
        if unread_only:
            query += " AND read = 0"
        query += " ORDER BY created_at DESC LIMIT ?"
        params.append(limit)

        items = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                items.append(FeedItem(
                    id=row[0], agent_id=row[1], entry_id=row[2],
                    headline=row[3], body=row[4], topic_path=row[5],
                    created_at=row[6], read=bool(row[7]),
                ))
        return items

    async def mark_read(self, feed_item_id: str) -> None:
        await self._db.execute("UPDATE feed_items SET read = 1 WHERE id = ?", (feed_item_id,))
        await self._db.commit()

    async def update_last_polled(self, interest_id: str, polled_at: str) -> None:
        await self._db.execute(
            "UPDATE interests SET last_polled = ? WHERE id = ?", (polled_at, interest_id)
        )
        await self._db.commit()

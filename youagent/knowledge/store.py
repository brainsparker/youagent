import json
from datetime import datetime
from pathlib import Path
from typing import Optional

import aiosqlite

from youagent.models.agent import Agent
from youagent.models.briefing import Briefing, BriefingSection
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
    read INTEGER DEFAULT 0,
    source_origin TEXT DEFAULT 'search'
);

CREATE TABLE IF NOT EXISTS briefings (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    sections_json TEXT NOT NULL,
    entry_ids_json TEXT NOT NULL,
    previous_briefing_id TEXT,
    llm_provider TEXT,
    llm_model TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
    id TEXT PRIMARY KEY,
    agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
    entry_id TEXT,
    title TEXT,
    summary TEXT,
    sources TEXT,
    topic_path TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    remote_agent_id TEXT,
    remote_endpoint TEXT,
    topics TEXT,
    cadence TEXT DEFAULT '6h',
    last_polled TEXT,
    active INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS engagement_events (
    id TEXT PRIMARY KEY,
    agent_id TEXT,
    feed_item_id TEXT,
    event_type TEXT NOT NULL,
    metadata_json TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS entities (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    aliases TEXT,
    mention_count INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS entity_relations (
    id TEXT PRIMARY KEY,
    source_entity_id TEXT REFERENCES entities(id),
    target_entity_id TEXT REFERENCES entities(id),
    relation_type TEXT NOT NULL,
    entry_id TEXT
);

CREATE TABLE IF NOT EXISTS entry_entities (
    entry_id TEXT,
    entity_id TEXT,
    PRIMARY KEY (entry_id, entity_id)
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

        # Schema migrations for new columns
        migrations = [
            "ALTER TABLE interests ADD COLUMN source_types TEXT",
            "ALTER TABLE feed_items ADD COLUMN source_agent_id TEXT DEFAULT ''",
            "ALTER TABLE feed_items ADD COLUMN source_agent_name TEXT DEFAULT ''",
            "ALTER TABLE feed_items ADD COLUMN parent_post_id TEXT DEFAULT ''",
            "ALTER TABLE subscriptions ADD COLUMN remote_agent_name TEXT DEFAULT ''",
            "ALTER TABLE posts ADD COLUMN parent_post_id TEXT",
        ]
        for sql in migrations:
            try:
                await self._db.execute(sql)
            except Exception:
                pass
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
        source_types_json = json.dumps(interest.source_types) if interest.source_types else None
        last_polled = interest.last_polled.isoformat() if interest.last_polled else None
        await self._db.execute(
            "INSERT OR REPLACE INTO interests (id, agent_id, path, queries, cadence, priority, last_polled, source_types) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (interest.id, agent_id, interest.path, queries_json,
             interest.cadence, interest.priority, last_polled, source_types_json),
        )
        await self._db.commit()

    async def list_interests(self, agent_id: str) -> list[Interest]:
        interests = []
        async with self._db.execute(
            "SELECT * FROM interests WHERE agent_id = ?", (agent_id,)
        ) as cursor:
            async for row in cursor:
                queries = json.loads(row[3]) if row[3] else None
                source_types = json.loads(row[7]) if len(row) > 7 and row[7] else []
                interests.append(Interest(
                    id=row[0], path=row[2], queries=queries,
                    cadence=row[4], priority=row[5],
                    source_types=source_types,
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
            "INSERT INTO feed_items (id, agent_id, entry_id, headline, body, topic_path, created_at, read, source_origin, source_agent_id, source_agent_name, parent_post_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (item.id, item.agent_id, item.entry_id, item.headline, item.body,
             item.topic_path, item.created_at.isoformat(), int(item.read),
             item.source_origin, item.source_agent_id, item.source_agent_name,
             item.parent_post_id),
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
                source_origin = row[8] if len(row) > 8 and row[8] else "search"
                source_agent_id = row[9] if len(row) > 9 and row[9] else ""
                source_agent_name = row[10] if len(row) > 10 and row[10] else ""
                parent_post_id = row[11] if len(row) > 11 and row[11] else ""
                items.append(FeedItem(
                    id=row[0], agent_id=row[1], entry_id=row[2],
                    headline=row[3], body=row[4], topic_path=row[5],
                    created_at=row[6], read=bool(row[7]),
                    source_origin=source_origin,
                    source_agent_id=source_agent_id,
                    source_agent_name=source_agent_name,
                    parent_post_id=parent_post_id,
                ))
        return items

    async def get_feed_item(self, item_id: str) -> Optional[FeedItem]:
        async with self._db.execute("SELECT * FROM feed_items WHERE id = ?", (item_id,)) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            source_origin = row[8] if len(row) > 8 and row[8] else "search"
            source_agent_id = row[9] if len(row) > 9 and row[9] else ""
            source_agent_name = row[10] if len(row) > 10 and row[10] else ""
            parent_post_id = row[11] if len(row) > 11 and row[11] else ""
            return FeedItem(
                id=row[0], agent_id=row[1], entry_id=row[2],
                headline=row[3], body=row[4], topic_path=row[5],
                created_at=row[6], read=bool(row[7]),
                source_origin=source_origin,
                source_agent_id=source_agent_id,
                source_agent_name=source_agent_name,
                parent_post_id=parent_post_id,
            )

    async def get_entry(self, entry_id: str) -> Optional[KnowledgeEntry]:
        async with self._db.execute("SELECT * FROM knowledge_entries WHERE id = ?", (entry_id,)) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return KnowledgeEntry(
                id=row[0], agent_id=row[1], interest_id=row[2],
                title=row[3], summary=row[4], raw_content=row[5],
                sources=json.loads(row[6]) if row[6] else [],
                relevance=row[7], novelty=row[8], created_at=row[9],
            )

    async def mark_read(self, feed_item_id: str) -> None:
        await self._db.execute("UPDATE feed_items SET read = 1 WHERE id = ?", (feed_item_id,))
        await self._db.commit()

    async def update_last_polled(self, interest_id: str, polled_at: str) -> None:
        await self._db.execute(
            "UPDATE interests SET last_polled = ? WHERE id = ?", (polled_at, interest_id)
        )
        await self._db.commit()

    # --- Briefings ---

    async def save_briefing(self, briefing: Briefing) -> None:
        sections_json = json.dumps([s.model_dump() for s in briefing.sections])
        entry_ids_json = json.dumps(briefing.entry_ids)
        await self._db.execute(
            "INSERT INTO briefings (id, agent_id, sections_json, entry_ids_json, previous_briefing_id, llm_provider, llm_model, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (briefing.id, briefing.agent_id, sections_json, entry_ids_json,
             briefing.previous_briefing_id, briefing.llm_provider, briefing.llm_model,
             briefing.created_at.isoformat()),
        )
        await self._db.commit()

    def _row_to_briefing(self, row) -> Briefing:
        sections = [BriefingSection(**s) for s in json.loads(row[2])]
        entry_ids = json.loads(row[3])
        return Briefing(
            id=row[0], agent_id=row[1], sections=sections, entry_ids=entry_ids,
            previous_briefing_id=row[4], llm_provider=row[5] or "",
            llm_model=row[6] or "", created_at=row[7],
        )

    async def get_latest_briefing(self, agent_id: str) -> Optional[Briefing]:
        async with self._db.execute(
            "SELECT * FROM briefings WHERE agent_id = ? ORDER BY created_at DESC LIMIT 1",
            (agent_id,),
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return self._row_to_briefing(row)

    async def get_briefing(self, briefing_id: str) -> Optional[Briefing]:
        async with self._db.execute(
            "SELECT * FROM briefings WHERE id = ?", (briefing_id,),
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return self._row_to_briefing(row)

    async def get_briefings(self, agent_id: str, limit: int = 10) -> list[Briefing]:
        briefings = []
        async with self._db.execute(
            "SELECT * FROM briefings WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
            (agent_id, limit),
        ) as cursor:
            async for row in cursor:
                briefings.append(self._row_to_briefing(row))
        return briefings

    async def get_entries_since(
        self, agent_id: str, since: datetime,
    ) -> list[KnowledgeEntry]:
        entries = []
        async with self._db.execute(
            "SELECT * FROM knowledge_entries WHERE agent_id = ? AND created_at > ? ORDER BY created_at DESC",
            (agent_id, since.isoformat()),
        ) as cursor:
            async for row in cursor:
                entries.append(KnowledgeEntry(
                    id=row[0], agent_id=row[1], interest_id=row[2],
                    title=row[3], summary=row[4], raw_content=row[5],
                    sources=json.loads(row[6]) if row[6] else [],
                    relevance=row[7], novelty=row[8], created_at=row[9],
                ))
        return entries

    # --- Posts (Phase 2) ---

    async def save_post(self, post: dict) -> None:
        await self._db.execute(
            "INSERT INTO posts (id, agent_id, entry_id, title, summary, sources, topic_path, created_at, parent_post_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (post["id"], post["agent_id"], post.get("entry_id"),
             post["title"], post["summary"],
             json.dumps(post.get("sources", [])),
             post.get("topic_path", ""), post["created_at"],
             post.get("parent_post_id", "")),
        )
        await self._db.commit()

    async def get_posts_since(self, agent_id: str, since: str) -> list[dict]:
        posts = []
        async with self._db.execute(
            "SELECT * FROM posts WHERE agent_id = ? AND created_at > ? ORDER BY created_at DESC",
            (agent_id, since),
        ) as cursor:
            async for row in cursor:
                posts.append({
                    "id": row[0], "agent_id": row[1], "entry_id": row[2],
                    "title": row[3], "summary": row[4],
                    "sources": json.loads(row[5]) if row[5] else [],
                    "topic_path": row[6], "created_at": row[7],
                })
        return posts

    async def get_posts(self, agent_id: str, limit: int = 50) -> list[dict]:
        posts = []
        async with self._db.execute(
            "SELECT * FROM posts WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?",
            (agent_id, limit),
        ) as cursor:
            async for row in cursor:
                posts.append({
                    "id": row[0], "agent_id": row[1], "entry_id": row[2],
                    "title": row[3], "summary": row[4],
                    "sources": json.loads(row[5]) if row[5] else [],
                    "topic_path": row[6], "created_at": row[7],
                })
        return posts

    # --- Subscriptions (Phase 2) ---

    async def save_subscription(self, sub: dict) -> None:
        await self._db.execute(
            "INSERT OR REPLACE INTO subscriptions (id, agent_id, remote_agent_id, remote_endpoint, topics, cadence, last_polled, active, remote_agent_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (sub["id"], sub["agent_id"], sub["remote_agent_id"],
             sub["remote_endpoint"],
             json.dumps(sub.get("topics", [])),
             sub.get("cadence", "6h"),
             sub.get("last_polled"), sub.get("active", 1),
             sub.get("remote_agent_name", "")),
        )
        await self._db.commit()

    async def get_subscriptions(self, agent_id: str, active_only: bool = True) -> list[dict]:
        query = "SELECT * FROM subscriptions WHERE agent_id = ?"
        params: list = [agent_id]
        if active_only:
            query += " AND active = 1"
        subs = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                subs.append({
                    "id": row[0], "agent_id": row[1],
                    "remote_agent_id": row[2], "remote_endpoint": row[3],
                    "topics": json.loads(row[4]) if row[4] else [],
                    "cadence": row[5], "last_polled": row[6],
                    "active": bool(row[7]),
                    "remote_agent_name": row[8] if len(row) > 8 and row[8] else "",
                })
        return subs

    async def delete_subscription(self, sub_id: str) -> None:
        await self._db.execute("DELETE FROM subscriptions WHERE id = ?", (sub_id,))
        await self._db.commit()

    async def update_subscription_polled(self, sub_id: str, polled_at: str) -> None:
        await self._db.execute(
            "UPDATE subscriptions SET last_polled = ? WHERE id = ?", (polled_at, sub_id)
        )
        await self._db.commit()

    async def set_subscription_active(self, sub_id: str, active: bool) -> None:
        await self._db.execute(
            "UPDATE subscriptions SET active = ? WHERE id = ?", (int(active), sub_id)
        )
        await self._db.commit()

    # --- Engagement (Phase 3) ---

    async def save_engagement(self, event: dict) -> None:
        await self._db.execute(
            "INSERT INTO engagement_events (id, agent_id, feed_item_id, event_type, metadata_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (event["id"], event["agent_id"], event["feed_item_id"],
             event["event_type"],
             json.dumps(event.get("metadata", {})),
             event["created_at"]),
        )
        await self._db.commit()

    async def get_engagements_since(self, agent_id: str, since: str) -> list[dict]:
        events = []
        async with self._db.execute(
            "SELECT * FROM engagement_events WHERE agent_id = ? AND created_at > ? ORDER BY created_at DESC",
            (agent_id, since),
        ) as cursor:
            async for row in cursor:
                events.append({
                    "id": row[0], "agent_id": row[1], "feed_item_id": row[2],
                    "event_type": row[3],
                    "metadata": json.loads(row[4]) if row[4] else {},
                    "created_at": row[5],
                })
        return events

    # --- Search (Phase 4) ---

    async def search_entries(self, agent_id: str, keywords: list[str], limit: int = 20) -> list[KnowledgeEntry]:
        if not keywords:
            return []
        conditions = []
        params: list = [agent_id]
        for kw in keywords:
            conditions.append("(title LIKE ? OR summary LIKE ?)")
            params.extend([f"%{kw}%", f"%{kw}%"])
        query = f"SELECT * FROM knowledge_entries WHERE agent_id = ? AND ({' OR '.join(conditions)}) ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        entries = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                entries.append(KnowledgeEntry(
                    id=row[0], agent_id=row[1], interest_id=row[2],
                    title=row[3], summary=row[4], raw_content=row[5],
                    sources=json.loads(row[6]) if row[6] else [],
                    relevance=row[7], novelty=row[8], created_at=row[9],
                ))
        return entries

    async def search_posts(self, keywords: list[str], limit: int = 20) -> list[dict]:
        if not keywords:
            return []
        conditions = []
        params: list = []
        for kw in keywords:
            conditions.append("(title LIKE ? OR summary LIKE ?)")
            params.extend([f"%{kw}%", f"%{kw}%"])
        query = f"SELECT * FROM posts WHERE {' OR '.join(conditions)} ORDER BY created_at DESC LIMIT ?"
        params.append(limit)
        posts = []
        async with self._db.execute(query, params) as cursor:
            async for row in cursor:
                posts.append({
                    "id": row[0], "agent_id": row[1], "entry_id": row[2],
                    "title": row[3], "summary": row[4],
                    "sources": json.loads(row[5]) if row[5] else [],
                    "topic_path": row[6], "created_at": row[7],
                })
        return posts

    # --- Entities (Phase 5) ---

    async def save_entity(self, entity: dict) -> None:
        existing = await self.find_entity(entity["name"])
        if existing:
            await self._db.execute(
                "UPDATE entities SET mention_count = mention_count + 1 WHERE id = ?",
                (existing["id"],),
            )
            await self._db.commit()
            return
        aliases = json.dumps(entity.get("aliases", []))
        await self._db.execute(
            "INSERT INTO entities (id, name, type, aliases, mention_count) VALUES (?, ?, ?, ?, ?)",
            (entity["id"], entity["name"], entity["type"], aliases,
             entity.get("mention_count", 1)),
        )
        await self._db.commit()

    async def find_entity(self, name: str) -> Optional[dict]:
        async with self._db.execute(
            "SELECT * FROM entities WHERE LOWER(name) = LOWER(?)", (name,)
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                # Check aliases
                async with self._db.execute(
                    "SELECT * FROM entities WHERE LOWER(aliases) LIKE ?",
                    (f'%{name.lower()}%',),
                ) as alias_cursor:
                    row = await alias_cursor.fetchone()
            if not row:
                return None
            return {
                "id": row[0], "name": row[1], "type": row[2],
                "aliases": json.loads(row[3]) if row[3] else [],
                "mention_count": row[4],
            }

    async def save_entity_relation(self, relation: dict) -> None:
        await self._db.execute(
            "INSERT INTO entity_relations (id, source_entity_id, target_entity_id, relation_type, entry_id) VALUES (?, ?, ?, ?, ?)",
            (relation["id"], relation["source_entity_id"],
             relation["target_entity_id"], relation["relation_type"],
             relation.get("entry_id")),
        )
        await self._db.commit()

    async def link_entry_entity(self, entry_id: str, entity_id: str) -> None:
        await self._db.execute(
            "INSERT OR IGNORE INTO entry_entities (entry_id, entity_id) VALUES (?, ?)",
            (entry_id, entity_id),
        )
        await self._db.commit()

    async def get_entity_entries(self, entity_id: str, limit: int = 20) -> list[KnowledgeEntry]:
        entries = []
        async with self._db.execute(
            "SELECT ke.* FROM knowledge_entries ke JOIN entry_entities ee ON ke.id = ee.entry_id WHERE ee.entity_id = ? ORDER BY ke.created_at DESC LIMIT ?",
            (entity_id, limit),
        ) as cursor:
            async for row in cursor:
                entries.append(KnowledgeEntry(
                    id=row[0], agent_id=row[1], interest_id=row[2],
                    title=row[3], summary=row[4], raw_content=row[5],
                    sources=json.loads(row[6]) if row[6] else [],
                    relevance=row[7], novelty=row[8], created_at=row[9],
                ))
        return entries

    async def get_related_entities(self, entity_id: str) -> list[dict]:
        relations = []
        async with self._db.execute(
            "SELECT er.*, e.name, e.type FROM entity_relations er JOIN entities e ON (er.target_entity_id = e.id OR er.source_entity_id = e.id) WHERE (er.source_entity_id = ? OR er.target_entity_id = ?) AND e.id != ?",
            (entity_id, entity_id, entity_id),
        ) as cursor:
            async for row in cursor:
                relations.append({
                    "id": row[0], "source_entity_id": row[1],
                    "target_entity_id": row[2], "relation_type": row[3],
                    "entry_id": row[4], "entity_name": row[5],
                    "entity_type": row[6],
                })
        return relations

import uuid
from datetime import datetime, timezone

from pydantic import BaseModel, Field


class Source(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    url: str
    title: str
    domain: str
    first_seen: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class KnowledgeEntry(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str
    interest_id: str
    title: str
    summary: str
    raw_content: str = ""
    sources: list[str] = Field(default_factory=list)
    relevance: float = 0.0
    novelty: float = 0.0
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class FeedItem(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str
    entry_id: str
    headline: str
    body: str
    topic_path: str
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    read: bool = False

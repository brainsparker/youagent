"""Data models for the network/follow graph."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field


class Subscription(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str
    remote_agent_id: str
    remote_endpoint: str
    topics: list[str] = Field(default_factory=list)
    cadence: str = "6h"
    last_polled: Optional[str] = None
    active: bool = True
    remote_agent_name: str = ""

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "agent_id": self.agent_id,
            "remote_agent_id": self.remote_agent_id,
            "remote_endpoint": self.remote_endpoint,
            "topics": self.topics,
            "cadence": self.cadence,
            "last_polled": self.last_polled,
            "active": int(self.active),
            "remote_agent_name": self.remote_agent_name,
        }


class Post(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str
    entry_id: Optional[str] = None
    title: str
    summary: str
    sources: list[str] = Field(default_factory=list)
    topic_path: str = ""
    created_at: str = Field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    parent_post_id: str = ""

    def to_dict(self) -> dict:
        return self.model_dump()

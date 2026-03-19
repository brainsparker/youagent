"""Data models for the knowledge graph."""

import uuid
from typing import Optional

from pydantic import BaseModel, Field


class Entity(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    type: str  # "company", "person", "technology", "policy", "organization"
    aliases: list[str] = Field(default_factory=list)
    mention_count: int = 1

    def to_dict(self) -> dict:
        return self.model_dump()


class EntityRelation(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    source_entity_id: str
    target_entity_id: str
    relation_type: str  # "competes_with", "funds", "develops", "regulates", "partners_with"
    entry_id: Optional[str] = None

    def to_dict(self) -> dict:
        return self.model_dump()

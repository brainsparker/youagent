import uuid
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field


class BriefingSection(BaseModel):
    kind: Literal[
        "executive_summary",
        "key_developments",
        "emerging_trends",
        "contradictions",
        "action_items",
    ]
    title: str
    content: str  # markdown
    source_refs: list[str] = Field(default_factory=list)


class Briefing(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    agent_id: str
    sections: list[BriefingSection] = Field(default_factory=list)
    entry_ids: list[str] = Field(default_factory=list)
    previous_briefing_id: Optional[str] = None
    llm_provider: str = ""
    llm_model: str = ""
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

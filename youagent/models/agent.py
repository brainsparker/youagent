import uuid
from datetime import datetime, timezone
from typing import Optional

from pydantic import BaseModel, Field

from youagent.models.card import AgentCard
from youagent.models.interest import Interest


class Agent(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str
    card: Optional[AgentCard] = None
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updated_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    def model_post_init(self, __context) -> None:
        if self.card is None:
            self.card = AgentCard(name=self.name, description=self.description)

    def add_interest(self, interest: Interest) -> None:
        self.card.x_youagent.interests.append(interest)
        self.updated_at = datetime.now(timezone.utc)

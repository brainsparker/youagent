from typing import Optional

from pydantic import BaseModel, Field

from youagent.models.interest import Interest


class KnowledgeSharing(BaseModel):
    publish: bool = True
    subscribe: bool = True
    human_approval_required: bool = False


class Skill(BaseModel):
    id: str
    name: str
    description: Optional[str] = None


class Capabilities(BaseModel):
    streaming: bool = False
    push_notifications: bool = Field(default=False, alias="pushNotifications")
    state_transition_history: bool = Field(default=True, alias="stateTransitionHistory")

    model_config = {"populate_by_name": True}


class YouAgentExtensions(BaseModel):
    interests: list[Interest] = Field(default_factory=list)
    knowledge_sharing: KnowledgeSharing = Field(default_factory=KnowledgeSharing)
    taxonomy_version: str = "1.0.0"
    custom_taxonomy_extensions: list[dict] = Field(default_factory=list)


class AgentCard(BaseModel):
    name: str
    description: str
    url: Optional[str] = None
    version: str = "1.0.0"
    capabilities: Capabilities = Field(default_factory=Capabilities)
    skills: list[Skill] = Field(
        default_factory=lambda: [
            Skill(
                id="knowledge-exchange",
                name="Knowledge Exchange",
                description="Share and receive topic intelligence",
            )
        ]
    )
    x_youagent: YouAgentExtensions = Field(
        default_factory=YouAgentExtensions, alias="x-youagent"
    )

    model_config = {"populate_by_name": True}

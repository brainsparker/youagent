"""A2A protocol data models — JSON-RPC 2.0, tasks, messages, artifacts, agent cards."""

import uuid
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Literal, Optional, Union

from pydantic import BaseModel, Field


# --- Parts ---

class TextPart(BaseModel):
    type: Literal["text"] = "text"
    text: str


class DataPart(BaseModel):
    type: Literal["data"] = "data"
    data: dict[str, Any]


Part = Union[TextPart, DataPart]


# --- Messages ---

class Message(BaseModel):
    role: Literal["user", "agent"]
    parts: list[Part]
    metadata: dict[str, Any] = Field(default_factory=dict)


# --- Tasks ---

class TaskState(str, Enum):
    WORKING = "working"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELED = "canceled"
    INPUT_REQUIRED = "input_required"


class TaskStatus(BaseModel):
    state: TaskState
    message: Optional[str] = None
    timestamp: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class Artifact(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    parts: list[Part] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class Task(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    context_id: Optional[str] = Field(default=None, alias="contextId")
    status: TaskStatus = Field(
        default_factory=lambda: TaskStatus(state=TaskState.WORKING)
    )
    artifacts: list[Artifact] = Field(default_factory=list)
    history: list[Message] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


# --- Agent Card ---

class Provider(BaseModel):
    organization: str = "YouAgent"
    url: str = "https://github.com/youagent/youagent"


class AgentCapabilities(BaseModel):
    streaming: bool = True
    push_notifications: bool = Field(default=False, alias="pushNotifications")
    extended_agent_card: bool = Field(default=False, alias="extendedAgentCard")

    model_config = {"populate_by_name": True}


class AgentSkill(BaseModel):
    id: str
    name: str
    description: str = ""
    tags: list[str] = Field(default_factory=list)
    examples: list[str] = Field(default_factory=list)


class A2AAgentCard(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    name: str
    description: str
    provider: Provider = Field(default_factory=Provider)
    endpoint: str = "http://localhost:8000/a2a"
    version: str = "0.3"
    capabilities: AgentCapabilities = Field(default_factory=AgentCapabilities)
    skills: list[AgentSkill] = Field(default_factory=list)
    security_schemes: dict[str, Any] = Field(
        default_factory=dict, alias="securitySchemes"
    )
    security: list[dict[str, Any]] = Field(default_factory=list)
    extensions: dict[str, Any] = Field(default_factory=dict)

    model_config = {"populate_by_name": True}


# --- JSON-RPC 2.0 ---

class JsonRpcRequest(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    method: str
    params: Optional[dict[str, Any]] = None
    id: Optional[Union[str, int]] = None


class JsonRpcError(BaseModel):
    code: int
    message: str
    data: Optional[Any] = None


class JsonRpcResponse(BaseModel):
    jsonrpc: Literal["2.0"] = "2.0"
    result: Optional[Any] = None
    error: Optional[JsonRpcError] = None
    id: Optional[Union[str, int]] = None


# Standard JSON-RPC error codes
PARSE_ERROR = -32700
INVALID_REQUEST = -32600
METHOD_NOT_FOUND = -32601
INVALID_PARAMS = -32602
INTERNAL_ERROR = -32603

# A2A-specific error codes
TASK_NOT_FOUND = -32001
TASK_NOT_CANCELABLE = -32002
UNSUPPORTED_OPERATION = -32003

import re
import uuid
from datetime import datetime
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator


class Interest(BaseModel):
    id: str = Field(default_factory=lambda: str(uuid.uuid4()))
    path: str
    queries: Optional[list[str]] = None
    cadence: str = "24h"
    priority: Literal["high", "medium", "low"] = "medium"
    last_polled: Optional[datetime] = None
    source_types: list[str] = Field(default_factory=list)

    @field_validator("cadence")
    @classmethod
    def validate_cadence(cls, v: str) -> str:
        if not re.match(r"^\d+[hmd]$", v):
            raise ValueError(f"Invalid cadence '{v}'. Use format like '6h', '30m', '1d'.")
        return v

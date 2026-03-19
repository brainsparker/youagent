"""Data models for Q&A responses."""

from pydantic import BaseModel, Field


class QAResponse(BaseModel):
    answer: str
    sources: list[str] = Field(default_factory=list)
    confidence: str = "medium"  # "high", "medium", "low"
    entries_used: int = 0

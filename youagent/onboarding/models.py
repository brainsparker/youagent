"""Pydantic models for onboarding results."""

from pydantic import BaseModel, Field


class OnboardingInterest(BaseModel):
    path: str
    queries: list[str] = Field(default_factory=list)
    cadence: str = "24h"
    priority: str = "medium"
    source_types: list[str] = Field(default_factory=list)


class OnboardingResult(BaseModel):
    agent_name: str
    agent_description: str
    interests: list[OnboardingInterest] = Field(default_factory=list)

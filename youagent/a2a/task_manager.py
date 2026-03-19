"""In-memory task manager for A2A protocol task lifecycle."""

import asyncio
from typing import Optional

from youagent.a2a.models import (
    Artifact,
    Message,
    Task,
    TaskState,
    TaskStatus,
)


class TaskManager:
    def __init__(self) -> None:
        self._tasks: dict[str, Task] = {}
        self._lock = asyncio.Lock()

    async def create_task(self, message: Message, context_id: Optional[str] = None) -> Task:
        async with self._lock:
            task = Task(context_id=context_id)
            task.history.append(message)
            self._tasks[task.id] = task
            return task

    async def get_task(self, task_id: str) -> Optional[Task]:
        return self._tasks.get(task_id)

    async def update_status(
        self,
        task_id: str,
        state: TaskState,
        message: Optional[str] = None,
    ) -> Optional[Task]:
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            task.status = TaskStatus(state=state, message=message)
            return task

    async def add_artifact(self, task_id: str, artifact: Artifact) -> Optional[Task]:
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            task.artifacts.append(artifact)
            return task

    async def add_message(self, task_id: str, message: Message) -> Optional[Task]:
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return None
            task.history.append(message)
            return task

    async def cancel_task(self, task_id: str) -> bool:
        async with self._lock:
            task = self._tasks.get(task_id)
            if not task:
                return False
            if task.status.state in (TaskState.COMPLETED, TaskState.FAILED, TaskState.CANCELED):
                return False
            task.status = TaskStatus(state=TaskState.CANCELED, message="Canceled by client")
            return True

    async def list_tasks(self) -> list[Task]:
        return list(self._tasks.values())

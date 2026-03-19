"""JWT authentication for hosted mode."""

import hashlib
import os
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Optional

import aiosqlite
from jose import JWTError, jwt
from pydantic import BaseModel

SECRET_KEY = os.environ.get("YOUAGENT_SECRET_KEY", "youagent-dev-secret-change-me")
ALGORITHM = "HS256"
TOKEN_EXPIRY_HOURS = 24


def _hash_password(password: str) -> str:
    salt = secrets.token_hex(16)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return f"{salt}${h}"


def _verify_password(password: str, hashed: str) -> bool:
    salt, expected = hashed.split("$", 1)
    h = hashlib.sha256((salt + password).encode()).hexdigest()
    return h == expected


class User(BaseModel):
    id: str
    email: str
    created_at: str


class UserCreate(BaseModel):
    email: str
    password: str


class Token(BaseModel):
    access_token: str
    token_type: str = "bearer"


USER_SCHEMA = """
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    hashed_password TEXT NOT NULL,
    youcom_api_key TEXT,
    created_at TEXT NOT NULL
);
"""


class AuthStore:
    def __init__(self, db: aiosqlite.Connection) -> None:
        self._db = db

    async def initialize(self) -> None:
        await self._db.executescript(USER_SCHEMA)
        await self._db.commit()

    async def create_user(self, email: str, password: str) -> User:
        user_id = str(uuid.uuid4())
        hashed = _hash_password(password)
        now = datetime.now(timezone.utc).isoformat()
        await self._db.execute(
            "INSERT INTO users (id, email, hashed_password, created_at) VALUES (?, ?, ?, ?)",
            (user_id, email, hashed, now),
        )
        await self._db.commit()
        return User(id=user_id, email=email, created_at=now)

    async def authenticate(self, email: str, password: str) -> Optional[User]:
        async with self._db.execute(
            "SELECT id, email, hashed_password, created_at FROM users WHERE email = ?",
            (email,),
        ) as cursor:
            row = await cursor.fetchone()
            if not row or not _verify_password(password, row[2]):
                return None
            return User(id=row[0], email=row[1], created_at=row[3])

    async def get_user(self, user_id: str) -> Optional[User]:
        async with self._db.execute(
            "SELECT id, email, created_at FROM users WHERE id = ?", (user_id,)
        ) as cursor:
            row = await cursor.fetchone()
            if not row:
                return None
            return User(id=row[0], email=row[1], created_at=row[2])

    async def set_api_key(self, user_id: str, api_key: str) -> None:
        await self._db.execute(
            "UPDATE users SET youcom_api_key = ? WHERE id = ?", (api_key, user_id)
        )
        await self._db.commit()

    async def get_api_key(self, user_id: str) -> Optional[str]:
        async with self._db.execute(
            "SELECT youcom_api_key FROM users WHERE id = ?", (user_id,)
        ) as cursor:
            row = await cursor.fetchone()
            return row[0] if row else None

    async def user_count(self) -> int:
        async with self._db.execute("SELECT COUNT(*) FROM users") as cursor:
            row = await cursor.fetchone()
            return row[0]


def create_token(user_id: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(hours=TOKEN_EXPIRY_HOURS)
    return jwt.encode({"sub": user_id, "exp": expire}, SECRET_KEY, algorithm=ALGORITHM)


def verify_token(token: str) -> Optional[str]:
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        return payload.get("sub")
    except JWTError:
        return None

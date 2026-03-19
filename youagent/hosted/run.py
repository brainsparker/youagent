"""Entry point for hosted mode — used by Dockerfile CMD."""

import asyncio
import os

from youagent.config.defaults import DB_PATH
from youagent.hosted.app import create_hosted_app

shared_key = os.environ.get("YOUAGENT_SHARED_API_KEY")
app = asyncio.run(create_hosted_app(db_path=DB_PATH, shared_api_key=shared_key))

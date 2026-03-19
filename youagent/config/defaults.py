import os
from pathlib import Path

YOUAGENT_HOME = Path(os.environ.get("YOUAGENT_HOME", Path.home() / ".youagent"))
CONFIG_FILE = YOUAGENT_HOME / "config.yaml"
AGENTS_DIR = YOUAGENT_HOME / "agents"
DATA_DIR = YOUAGENT_HOME / "data"
DB_PATH = DATA_DIR / "youagent.db"
CUSTOM_TAXONOMY_PATH = YOUAGENT_HOME / "taxonomy" / "custom.yaml"

DEFAULT_CADENCE = "24h"
DEFAULT_PRIORITY = "medium"
TAXONOMY_VERSION = "1.0.0"

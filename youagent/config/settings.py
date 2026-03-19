from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel

from youagent.config.defaults import CONFIG_FILE, YOUAGENT_HOME


class YouAgentSettings(BaseModel):
    youcom_api_key: Optional[str] = None
    home_dir: Path = YOUAGENT_HOME
    config_file: Path = CONFIG_FILE

    # LLM settings for synthesis
    llm_provider: Optional[str] = None  # "claude" or "openai"
    llm_api_key: Optional[str] = None
    llm_model: Optional[str] = None
    synthesis_cadence: str = "6h"

    @classmethod
    def load(cls) -> "YouAgentSettings":
        if CONFIG_FILE.exists():
            with open(CONFIG_FILE) as f:
                data = yaml.safe_load(f) or {}
            return cls(**data)
        return cls()

    def save(self) -> None:
        self.config_file.parent.mkdir(parents=True, exist_ok=True)
        with open(self.config_file, "w") as f:
            yaml.dump(self.model_dump(mode="json", exclude_none=True), f)

    def ensure_dirs(self) -> None:
        for d in [
            self.home_dir,
            self.home_dir / "agents",
            self.home_dir / "data",
            self.home_dir / "taxonomy",
        ]:
            d.mkdir(parents=True, exist_ok=True)

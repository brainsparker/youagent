from pathlib import Path

import pytest

from youagent.config.settings import YouAgentSettings


@pytest.fixture
def tmp_home(tmp_path: Path) -> Path:
    home = tmp_path / ".youagent"
    home.mkdir()
    (home / "agents").mkdir()
    (home / "data").mkdir()
    (home / "taxonomy").mkdir()
    return home


@pytest.fixture
def settings(tmp_home: Path) -> YouAgentSettings:
    return YouAgentSettings(
        home_dir=tmp_home,
        config_file=tmp_home / "config.yaml",
        youcom_api_key="test-api-key",
    )

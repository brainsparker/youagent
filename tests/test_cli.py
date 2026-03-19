from typer.testing import CliRunner

from youagent.cli.main import app

runner = CliRunner()


class TestCLI:
    def test_version(self):
        result = runner.invoke(app, ["--version"])
        assert result.exit_code == 0
        assert "0.1.0" in result.stdout

    def test_init_creates_config(self, tmp_path, monkeypatch):
        monkeypatch.setenv("YOUAGENT_HOME", str(tmp_path / ".youagent"))
        result = runner.invoke(app, ["init"], input="test-api-key\n")
        assert result.exit_code == 0
        assert (tmp_path / ".youagent" / "config.yaml").exists()

    def test_taxonomy_show(self):
        result = runner.invoke(app, ["taxonomy", "show"])
        assert result.exit_code == 0
        assert "technology" in result.stdout

    def test_taxonomy_search(self):
        result = runner.invoke(app, ["taxonomy", "search", "quantum"])
        assert result.exit_code == 0
        assert "quantum" in result.stdout


class TestCLIIntegration:
    def test_full_flow(self, tmp_path, monkeypatch):
        """Create agent -> add interest -> list agents."""
        home = tmp_path / ".youagent"
        monkeypatch.setenv("YOUAGENT_HOME", str(home))

        # Init
        result = runner.invoke(app, ["init"], input="test-api-key\n")
        assert result.exit_code == 0

        # Create agent
        result = runner.invoke(app, ["agent", "create", "--name", "Test Agent",
                                      "--description", "Integration test",
                                      "--interests", "technology/ai/regulation"])
        assert result.exit_code == 0
        assert "Created agent" in result.stdout

        # List agents
        result = runner.invoke(app, ["agent", "list"])
        assert result.exit_code == 0
        assert "Test Agent" in result.stdout

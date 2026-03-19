from youagent.scheduler.engine import SchedulerEngine


class TestSchedulerEngine:
    def test_parse_cadence_hours(self):
        engine = SchedulerEngine.__new__(SchedulerEngine)
        assert engine._parse_cadence("6h") == {"hours": 6}

    def test_parse_cadence_minutes(self):
        engine = SchedulerEngine.__new__(SchedulerEngine)
        assert engine._parse_cadence("30m") == {"minutes": 30}

    def test_parse_cadence_days(self):
        engine = SchedulerEngine.__new__(SchedulerEngine)
        assert engine._parse_cadence("1d") == {"days": 1}

    def test_create_engine(self):
        engine = SchedulerEngine(api_key="test", db_path="/tmp/test.db")
        assert engine is not None
        assert engine._scheduler is not None

"""A running agent sees changed SCADA; checkout line endings do not invalidate evidence."""

from types import SimpleNamespace

import pandas as pd

from app import data
from app.agent import tools


def sources(tmp_path, monkeypatch):
    monkeypatch.setattr(data, "DATA_RAW", tmp_path)
    monkeypatch.setattr(data, "TURBINES", {1: SimpleNamespace(raw_file="one.csv")})
    path = tmp_path / "one.csv"
    path.write_bytes(b"power\n1\n")
    return path


def test_running_agent_refreshes_facts_without_restart(tmp_path, monkeypatch):
    path = sources(tmp_path, monkeypatch)
    calls = []

    def load():
        calls.append(True)
        return pd.DataFrame({"p": [int(path.read_text().splitlines()[1])]})

    monkeypatch.setattr(tools, "farm_hourly", load)
    tools._facts_for_source.cache_clear()
    try:
        first = tools.facts()
        assert tools.facts() is first
        path.write_bytes(b"power\n2\n")  # same length: content, not file size alone
        second = tools.facts()
        assert first["p"].iloc[0] == 1
        assert second["p"].iloc[0] == 2
        assert tools.facts() is second
        assert len(calls) == 2
    finally:
        tools._facts_for_source.cache_clear()


def test_raw_fingerprint_is_equal_for_lf_and_crlf(tmp_path, monkeypatch):
    path = sources(tmp_path, monkeypatch)
    before = data.raw_fingerprint()
    path.write_bytes(b"power\r\n1\r\n")
    assert data.raw_fingerprint() == before
    path.write_bytes(b"power\r\n2\r\n")
    assert data.raw_fingerprint() != before


def test_unchanged_source_reuses_content_hash(tmp_path, monkeypatch):
    sources(tmp_path, monkeypatch)
    data._csv_hash.cache_clear()
    data.raw_fingerprint()
    initial = data._csv_hash.cache_info()
    data.raw_fingerprint()
    later = data._csv_hash.cache_info()
    assert later.misses == initial.misses
    assert later.hits == initial.hits + 1

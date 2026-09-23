from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_reports_demo_mode_without_key(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body == {"ok": True, "mode": "demo", "commit": "dev"}


def test_analyze_valid_text_returns_200():
    response = client.post("/api/analyze", json={"text": "Пример текста"})
    assert response.status_code == 200
    body = response.json()
    assert body["mode"] in ("llm", "demo")
    assert 0 <= body["score"] <= 1
    assert isinstance(body["reasons"], list)


def test_analyze_empty_text_returns_422():
    response = client.post("/api/analyze", json={"text": ""})
    assert response.status_code == 422


def test_index_page_served_as_html():
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_reports_demo_mode_without_key(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body == {"ok": True, "mode": "demo", "commit": "dev"}


def test_issues_endpoint_returns_list():
    response = client.get("/api/issues")
    assert response.status_code == 200
    assert isinstance(response.json(), list)


def test_index_page_served_as_html():
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]

import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.llm import llm_mode
from app.schemas import AnalyzeInput, AnalyzeResult
from app.service import analyze

app = FastAPI(title="CtrlX · HackAlem")


@app.get("/api/health")
def health() -> dict:
    return {"ok": True, "mode": llm_mode(), "commit": os.getenv("COMMIT", "dev")}


@app.post("/api/analyze", response_model=AnalyzeResult)
def api_analyze(inp: AnalyzeInput) -> AnalyzeResult:
    return analyze(inp)


# Resolved relative to this file (not the cwd) so `static/` is found no matter
# where `uvicorn app.main:app` is launched from.
_STATIC_DIR = Path(__file__).resolve().parent.parent / "static"

# Mounted after the API routes so it only catches what they don't.
app.mount("/", StaticFiles(directory=_STATIC_DIR, html=True), name="static")

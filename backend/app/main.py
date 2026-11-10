import json
import os
import re
import time
import uuid
from collections import defaultdict
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

import pandas as pd  # noqa: E402
from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile  # noqa: E402
from fastapi.middleware.cors import CORSMiddleware  # noqa: E402
from fastapi.responses import FileResponse, StreamingResponse  # noqa: E402
from pydantic import BaseModel  # noqa: E402
from sqlalchemy import create_engine, text  # noqa: E402

from .agent import graph  # noqa: E402

RUNS = Path(__file__).resolve().parent.parent / "runs"
RUNS.mkdir(exist_ok=True)
MAX_BYTES = 20 * 1024 * 1024

app = FastAPI(title="Autonomous Data Analyst")
ORIGINS = ["http://localhost:5173"] + [
    o.strip().rstrip("/") for o in os.getenv("FRONTEND_ORIGIN", "").split(",") if o.strip()
]
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["*"], allow_headers=["*"])

HITS: dict = defaultdict(list)


def rate_limit(request: Request):
    """Simple per-IP cap on new runs (in memory, resets on restart)."""
    fwd = request.headers.get("x-forwarded-for", "")
    ip = fwd.split(",")[0].strip() or (request.client.host if request.client else "?")
    now = time.time()
    HITS[ip] = [t for t in HITS[ip] if now - t < 3600]
    if len(HITS[ip]) >= int(os.getenv("RUNS_PER_HOUR", "10")):
        raise HTTPException(429, "Run limit reached. Try again in an hour.")
    HITS[ip].append(now)


@app.get("/api/health")
def health():
    return {"ok": True}


def new_run(question: str) -> tuple[str, Path]:
    rid = uuid.uuid4().hex[:12]
    d = RUNS / rid
    d.mkdir()
    (d / "meta.json").write_text(json.dumps({"question": question}))
    return rid, d


def run_dir(rid: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{12}", rid) or not (RUNS / rid).exists():
        raise HTTPException(404, "Run not found")
    return RUNS / rid


@app.post("/api/runs")
async def create_from_csv(request: Request, file: UploadFile = File(...), question: str = Form(...)):
    rate_limit(request)
    data = await file.read()
    if len(data) > MAX_BYTES:
        raise HTTPException(413, "CSV is larger than 20 MB")
    rid, d = new_run(question)
    (d / "data.csv").write_bytes(data)
    try:
        pd.read_csv(d / "data.csv", nrows=5)
    except Exception:
        raise HTTPException(400, "That file could not be read as a CSV")
    return {"run_id": rid}


class Connect(BaseModel):
    url: str        # SQLAlchemy URL, e.g. sqlite:///shop.db or postgresql+psycopg2://...
    query: str      # a single SELECT
    question: str


@app.post("/api/runs/connect")
def create_from_db(b: Connect, request: Request):
    if os.getenv("ENABLE_DB", "true") != "true":
        raise HTTPException(403, "Database connections are disabled on this deployment")
    rate_limit(request)
    q = b.query.strip().rstrip(";")
    if not re.match(r"(?is)^\s*(select|with)\b", q) or ";" in q:
        raise HTTPException(400, "Only a single SELECT query is allowed")
    try:
        df = pd.read_sql(text(q), create_engine(b.url)).head(200_000)
    except Exception as e:
        raise HTTPException(400, f"Database error: {str(e)[:300]}")
    rid, d = new_run(b.question)
    df.to_csv(d / "data.csv", index=False)
    return {"run_id": rid}


WANTED = {"profile", "plan", "code", "step_label", "error", "stdout", "new_charts", "report"}


@app.get("/api/runs/{rid}/stream")
def stream(rid: str):
    d = run_dir(rid)
    question = json.loads((d / "meta.json").read_text())["question"]

    def sse(obj):
        return f"data: {json.dumps(obj, default=str)}\n\n"

    def gen():
        try:
            for chunk in graph.stream({"run_dir": str(d), "question": question}, stream_mode="updates"):
                for node, update in chunk.items():
                    yield sse({"node": node, **{k: v for k, v in (update or {}).items() if k in WANTED}})
        except Exception as e:  # surface LLM/auth failures to the UI
            yield sse({"node": "fatal", "message": str(e)[:400]})
        yield sse({"node": "done"})

    return StreamingResponse(gen(), media_type="text/event-stream",
                             headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})


@app.get("/api/runs/{rid}/charts/{name}")
def chart(rid: str, name: str):
    if not re.fullmatch(r"[\w\-]+\.png", name):
        raise HTTPException(400, "Bad chart name")
    p = run_dir(rid) / "charts" / name
    if not p.exists():
        raise HTTPException(404, "Chart not found")
    return FileResponse(p)


@app.get("/api/runs/{rid}/report.md")
def report(rid: str):
    p = run_dir(rid) / "report.md"
    if not p.exists():
        raise HTTPException(404, "Report not ready")
    return FileResponse(p, filename="report.md")

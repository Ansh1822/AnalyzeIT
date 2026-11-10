# Autonomous Data Analyst Agent

Upload a CSV (or run a SELECT against a database). A LangGraph agent powered by Groq profiles the data, plans an analysis, writes and runs pandas code in a sandbox, repairs its own errors, draws charts and writes a Markdown report. Progress streams to a React UI live.

## Run it (Windows PowerShell)

Backend
```
cd backend
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
copy .env.example .env      # then paste your free Groq key into .env
uvicorn app.main:app --reload --port 8000
```

Frontend (new terminal)
```
cd frontend
npm install
npm run dev
```
Open http://localhost:5173 and try `sample/sales.csv`.

## Docker sandbox (optional, safer)
```
docker build -t analyst-sandbox backend/sandbox
```
Then set `SANDBOX=docker` in `backend/.env`. Generated code then runs with no network, 512 MB RAM, 1 CPU.

## Workflow
profile -> plan -> [code -> execute -> (error? fix up to 3x, else skip)] x each step -> report

| File | Role |
|---|---|
| `backend/app/agent.py` | LangGraph state machine: nodes, retry routing |
| `backend/app/sandbox.py` | Runs generated code in a subprocess or container, collects charts |
| `backend/app/llm.py` | Groq call |
| `backend/app/main.py` | Upload/connect endpoints, SSE stream, chart and report serving |
| `frontend/src/App.jsx` | Form, EventSource listener, live timeline, report view |

## Notes
- Local mode isolates by process only. Use Docker before exposing this to other people.
- For databases, connect with a read-only DB user. The API only accepts one SELECT, but the DB user is the real safeguard.
- Swap model with `GROQ_MODEL` (e.g. `llama-3.1-8b-instant` if you hit rate limits).

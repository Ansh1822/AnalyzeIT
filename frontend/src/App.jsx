import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API = import.meta.env.VITE_API_URL || "";
const chartUrl = (runId, name) => `${API}/api/runs/${runId}/charts/${name}`;

export default function App() {
  const [mode, setMode] = useState("csv");
  const [file, setFile] = useState(null);
  const [dbUrl, setDbUrl] = useState("sqlite:///shop.db");
  const [dbQuery, setDbQuery] = useState("SELECT * FROM orders");
  const [question, setQuestion] = useState("");
  const [runId, setRunId] = useState(null);
  const [events, setEvents] = useState([]);
  const [report, setReport] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const source = useRef(null);

  const canRun = !running && question.trim() && (mode === "csv" ? file : dbUrl && dbQuery);

  async function start() {
    setError(""); setEvents([]); setReport(""); setRunning(true);
    try {
      let res;
      if (mode === "csv") {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("question", question);
        res = await fetch(`${API}/api/runs`, { method: "POST", body: fd });
      } else {
        res = await fetch(`${API}/api/runs/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: dbUrl, query: dbQuery, question }),
        });
      }
      if (!res.ok) throw new Error((await res.json()).detail || "Could not start the run");
      const { run_id } = await res.json();
      setRunId(run_id);

      const es = new EventSource(`${API}/api/runs/${run_id}/stream`);
      source.current = es;
      es.onmessage = (m) => {
        const ev = JSON.parse(m.data);
        if (ev.node === "done") { es.close(); setRunning(false); return; }
        if (ev.node === "fatal") { setError(ev.message); es.close(); setRunning(false); return; }
        if (ev.node === "report") setReport(ev.report);
        setEvents((prev) => [...prev, ev]);
      };
      es.onerror = () => { es.close(); setRunning(false); };
    } catch (e) {
      setError(e.message); setRunning(false);
    }
  }

  const reportMd = report.replaceAll("](charts/", `](${API}/api/runs/${runId}/charts/`);

  return (
    <div className="shell">
      <aside className="rail">
        <h1>Data analyst agent</h1>
        <p className="sub">Ask a question about your data. The agent plans, runs code, fixes its own errors and writes the report.</p>

        <div className="tabs" role="tablist">
          <button role="tab" aria-selected={mode === "csv"} onClick={() => setMode("csv")}>CSV file</button>
          <button role="tab" aria-selected={mode === "db"} onClick={() => setMode("db")}>Database</button>
        </div>

        {mode === "csv" ? (
          <label className="drop">
            <input type="file" accept=".csv" onChange={(e) => setFile(e.target.files[0])} />
            {file ? file.name : "Choose a CSV (up to 20 MB)"}
          </label>
        ) : (
          <>
            <label>Connection URL<input value={dbUrl} onChange={(e) => setDbUrl(e.target.value)} /></label>
            <label>Query<textarea rows={3} value={dbQuery} onChange={(e) => setDbQuery(e.target.value)} /></label>
          </>
        )}

        <label>Your question
          <textarea rows={4} value={question} onChange={(e) => setQuestion(e.target.value)}
            placeholder="Which region and category drive revenue, and do discounts help?" />
        </label>

        <button className="go" disabled={!canRun} onClick={start}>
          {running ? "Analysing…" : "Run analysis"}
        </button>
        {error && <p className="err" role="alert">{error}</p>}
      </aside>

      <main className="stage">
        {!events.length && !running && (
          <p className="empty">Upload data and ask a question. Each step the agent takes will appear here as it happens.</p>
        )}

        {events.map((ev, i) => <Step key={i} ev={ev} runId={runId} />)}
        {running && <p className="pulse">Working…</p>}

        {report && (
          <article className="report">
            <div className="report-head">
              <h2>Report</h2>
              <a href={`${API}/api/runs/${runId}/report.md`}>Download .md</a>
            </div>
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportMd}</ReactMarkdown>
          </article>
        )}
      </main>
    </div>
  );
}

function Step({ ev, runId }) {
  switch (ev.node) {
    case "profile":
      return <section className="step"><h3>Profiled the dataset</h3><pre>{ev.profile}</pre></section>;
    case "plan":
      return (
        <section className="step"><h3>Plan</h3>
          <ol>{ev.plan.map((p, i) => <li key={i}>{p}</li>)}</ol>
        </section>
      );
    case "code":
      return (
        <section className="step"><h3>Writing code: {ev.step_label}</h3>
          <details><summary>Show code</summary><pre>{ev.code}</pre></details>
        </section>
      );
    case "execute":
      return ev.error ? (
        <section className="step bad"><h3>Run failed, fixing</h3><pre>{ev.error}</pre></section>
      ) : (
        <section className="step ok"><h3>Run succeeded</h3>
          {ev.stdout && <pre>{ev.stdout}</pre>}
          <div className="charts">
            {ev.new_charts?.map((c) => <img key={c} src={chartUrl(runId, c)} alt={c.replace(".png", "")} />)}
          </div>
        </section>
      );
    case "skip":
      return <section className="step bad"><h3>Skipped a step after repeated failures</h3></section>;
    case "report":
      return <section className="step ok"><h3>Report written</h3></section>;
    default:
      return null;
  }
}

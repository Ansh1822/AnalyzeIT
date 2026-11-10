import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const API = import.meta.env.VITE_API_URL || "";
const chartUrl = (runId, name) => `${API}/api/runs/${runId}/charts/${name}`;

export default function App() {
  const [mode, setMode] = useState("csv");
  const [file, setFile] = useState(null);
  const [dbUrl, setDbUrl] = useState("sqlite:///shop.db");
  const [dbQuery, setDbQuery] = useState("SELECT * FROM orders LIMIT 500");
  const [question, setQuestion] = useState("");
  const [runId, setRunId] = useState(null);
  const [events, setEvents] = useState([]);
  const [report, setReport] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [elapsed, setElapsed] = useState(0);

  const source = useRef(null);
  const timerRef = useRef(null);
  const fileInputRef = useRef(null);

  // Elapsed timer tracker
  useEffect(() => {
    if (running) {
      setElapsed(0);
      timerRef.current = setInterval(() => setElapsed((t) => t + 1), 1000);
    } else {
      clearInterval(timerRef.current);
    }
    return () => clearInterval(timerRef.current);
  }, [running]);

  const canRun = !running && question.trim() && (mode === "csv" ? !!file : !!dbUrl.trim() && !!dbQuery.trim());

  function stopRun() {
    if (source.current) {
      source.current.close();
      source.current = null;
    }
    setRunning(false);
  }

  async function start() {
    setError("");
    setEvents([]);
    setReport("");
    setRunning(true);

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

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.detail || `Server error (${res.status})`);
      }

      const { run_id } = await res.json();
      setRunId(run_id);

      const es = new EventSource(`${API}/api/runs/${run_id}/stream`);
      source.current = es;

      es.onmessage = (m) => {
        try {
          const ev = JSON.parse(m.data);
          if (ev.node === "done") {
            es.close();
            setRunning(false);
            return;
          }
          if (ev.node === "fatal") {
            setError(ev.message || "An unexpected error interrupted the analysis.");
            es.close();
            setRunning(false);
            return;
          }
          if (ev.node === "report") {
            setReport(ev.report);
          }
          setEvents((prev) => [...prev, ev]);
        } catch (err) {
          console.error("Failed to parse event stream payload", err);
        }
      };

      es.onerror = () => {
        es.close();
        setRunning(false);
      };
    } catch (e) {
      setError(e.message);
      setRunning(false);
    }
  }

  const formatFileSize = (bytes) => {
    if (!bytes) return "";
    const kb = bytes / 1024;
    return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${Math.round(kb)} KB`;
  };

  const reportMd = report.replaceAll("](charts/", `](${API}/api/runs/${runId}/charts/`);

  return (
    <div className="shell">
      <aside className="rail">
        <header className="brand">
          <div className="brand-badge">SQL & tabular</div>
          <h1>Insight Studio</h1>
          <p className="sub">Explore patterns, compute statistics, and visualize metrics from raw data.</p>
        </header>

        <section className="config-group">
          <div className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={mode === "csv"}
              onClick={() => setMode("csv")}
            >
              CSV File
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === "db"}
              onClick={() => setMode("db")}
            >
              SQL Database
            </button>
          </div>

          {mode === "csv" ? (
            <div className="dropzone-wrap">
              <input
                ref={fileInputRef}
                type="file"
                accept=".csv"
                id="csv-file-input"
                className="sr-only"
                onChange={(e) => setFile(e.target.files[0] || null)}
              />
              <label htmlFor="csv-file-input" className={`dropzone ${file ? "has-file" : ""}`}>
                <div className="dropzone-icon">📁</div>
                <div className="dropzone-meta">
                  <span className="file-name">{file ? file.name : "Select or drag a CSV file"}</span>
                  <span className="file-hint">
                    {file ? formatFileSize(file.size) : "Standard RFC 4180 format up to 20MB"}
                  </span>
                </div>
              </label>
              {file && (
                <button
                  type="button"
                  className="btn-link"
                  onClick={() => {
                    setFile(null);
                    if (fileInputRef.current) fileInputRef.current.value = "";
                  }}
                >
                  Clear file
                </button>
              )}
            </div>
          ) : (
            <div className="db-fields">
              <label>
                Database URI
                <input
                  type="text"
                  spellCheck="false"
                  value={dbUrl}
                  placeholder="postgresql://user:pass@localhost:5432/dbname"
                  onChange={(e) => setDbUrl(e.target.value)}
                />
              </label>
              <label>
                Initial Query
                <textarea
                  rows={3}
                  spellCheck="false"
                  className="font-mono"
                  value={dbQuery}
                  onChange={(e) => setDbQuery(e.target.value)}
                />
              </label>
            </div>
          )}
        </section>

        <section className="prompt-group">
          <label>
            Analysis prompt
            <textarea
              rows={4}
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="e.g., Identify seasonal churn drivers by plan tier and chart the correlation between NPS and monthly spend."
            />
          </label>

          <div className="action-row">
            <button
              type="button"
              className="btn-primary"
              disabled={!canRun}
              onClick={start}
            >
              {running ? (
                <>
                  <span className="spinner" /> Running analysis...
                </>
              ) : (
                "Run Analysis"
              )}
            </button>

            {running && (
              <button type="button" className="btn-secondary" onClick={stopRun}>
                Cancel
              </button>
            )}
          </div>

          {running && (
            <div className="timer-badge">
              Active process: <strong>{elapsed}s</strong>
            </div>
          )}

          {error && (
            <div className="err-banner" role="alert">
              <strong>Error:</strong> {error}
            </div>
          )}
        </section>
      </aside>

      <main className="stage">
        {!events.length && !running && (
          <div className="empty-state">
            <div className="empty-icon">📊</div>
            <h2>No active analysis</h2>
            <p>
              Connect your data source and state what questions or metrics you'd like answered. Execution logs, charts, and key takeaways will be published here in real time.
            </p>
          </div>
        )}

        <div className="timeline">
          {events.map((ev, i) => (
            <Step key={i} ev={ev} runId={runId} />
          ))}
        </div>

        {running && (
          <div className="live-status">
            <span className="dot-pulse" />
            <span>Processing data and verifying outputs...</span>
          </div>
        )}

        {report && (
          <article className="report-card">
            <header className="report-header">
              <div>
                <h2>Executive Summary & Findings</h2>
                <span className="timestamp">Run #{runId?.slice(0, 8) || "local"}</span>
              </div>
              <a
                className="btn-download"
                href={`${API}/api/runs/${runId}/report.md`}
                download="analysis-report.md"
              >
                Download Markdown
              </a>
            </header>
            <div className="report-body">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{reportMd}</ReactMarkdown>
            </div>
          </article>
        )}
      </main>
    </div>
  );
}

function Step({ ev, runId }) {
  const [open, setOpen] = useState(false);

  switch (ev.node) {
    case "profile":
      return (
        <section className="step-card">
          <header className="step-header">
            <span className="step-tag neutral">Schema & Profiling</span>
            <span className="step-title">Inspected dataset structure</span>
          </header>
          <pre className="code-block">{ev.profile}</pre>
        </section>
      );

    case "plan":
      return (
        <section className="step-card">
          <header className="step-header">
            <span className="step-tag neutral">Methodology</span>
            <span className="step-title">Planned execution steps</span>
          </header>
          <ol className="plan-list">
            {ev.plan.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ol>
        </section>
      );

    case "code":
      return (
        <section className="step-card">
          <header className="step-header">
            <span className="step-tag accent">Code Generation</span>
            <span className="step-title">{ev.step_label || "Analysis script"}</span>
          </header>
          <details className="code-details" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
            <summary>{open ? "Hide source snippet" : "View generated Python snippet"}</summary>
            <pre className="code-block">{ev.code}</pre>
          </details>
        </section>
      );

    case "execute":
      return ev.error ? (
        <section className="step-card failure">
          <header className="step-header">
            <span className="step-tag error">Execution Retry</span>
            <span className="step-title">Encountered an exception — correcting logic</span>
          </header>
          <pre className="code-block err-block">{ev.error}</pre>
        </section>
      ) : (
        <section className="step-card success">
          <header className="step-header">
            <span className="step-tag success">Completed Step</span>
            <span className="step-title">Execution passed</span>
          </header>
          {ev.stdout && <pre className="code-block">{ev.stdout}</pre>}
          {ev.new_charts && ev.new_charts.length > 0 && (
            <div className="chart-grid">
              {ev.new_charts.map((c) => (
                <figure key={c} className="chart-item">
                  <img src={chartUrl(runId, c)} alt={c.replace(/\.[^/.]+$/, "")} loading="lazy" />
                  <figcaption>{c}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </section>
      );

    case "skip":
      return (
        <section className="step-card failure">
          <header className="step-header">
            <span className="step-tag error">Step Skipped</span>
            <span className="step-title">Bypassed non-critical step after fallback limits</span>
          </header>
        </section>
      );

    case "report":
      return (
        <section className="step-card success">
          <header className="step-header">
            <span className="step-tag success">Report Generated</span>
            <span className="step-title">Synthesized insights and rendered charts</span>
          </header>
        </section>
      );

    default:
      return null;
  }
}
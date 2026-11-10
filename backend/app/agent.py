"""LangGraph agent: profile -> plan -> (code -> execute -> fix loop) per step -> report."""
import json
import re
from pathlib import Path
from typing import TypedDict

import pandas as pd
from langgraph.graph import END, START, StateGraph

from .llm import ask
from .sandbox import run_python

MAX_FIXES = 3


class State(TypedDict, total=False):
    run_dir: str
    question: str
    profile: str
    plan: list
    step: int          # index of the plan step being worked on
    step_label: str
    code: str
    error: str
    attempts: int      # failed attempts on the current step
    stdout: str
    new_charts: list
    findings: list     # [{step, output, charts, failed}]
    report: str


# ---------- prompts ----------
PLAN_SYS = (
    "You are a senior data analyst. Given a dataset profile and a question, write a short "
    "analysis plan of 4 to 6 concrete steps (cleaning checks, aggregations, comparisons, "
    "at least two charts). Reply with ONLY a JSON array of strings."
)
CODE_SYS = (
    "You write Python for ONE analysis step. A DataFrame `df` is already loaded from the CSV, "
    "and pandas as pd, numpy as np, matplotlib.pyplot as plt are imported. "
    "Rules: print() every number you want to report (compact, rounded); "
    "to make a chart, draw with plt then call save_chart('short_snake_name'); "
    "never call plt.show(); do not read or write other files; "
    "the step runs in a fresh process, so redo any cleaning you need. "
    "Reply with ONE ```python code block and nothing else."
)
REPORT_SYS = (
    "You are a data analyst writing a report for a non-technical reader. Use ONLY the numbers "
    "in the findings; never invent figures. Markdown with sections: Summary, Key findings, "
    "Recommendations, Caveats. Embed relevant charts as ![title](charts/<file>.png) using only "
    "the chart files provided."
)


def _json_list(text: str) -> list:
    m = re.search(r"\[.*\]", text, re.S)
    try:
        items = json.loads(m.group(0)) if m else []
    except json.JSONDecodeError:
        items = []
    items = [str(i) for i in items if str(i).strip()]
    return items[:6] or ["Summarise the dataset", "Explore key relationships", "Chart the main trend"]


def _code_block(text: str) -> str:
    m = re.search(r"```(?:python)?\s*\n(.*?)```", text, re.S)
    return (m.group(1) if m else text).strip()


# ---------- nodes ----------
def profile_node(s: State) -> State:
    df = pd.read_csv(Path(s["run_dir"]) / "data.csv")
    lines = [f"rows={len(df)}, columns={df.shape[1]}"]
    for c in list(df.columns)[:60]:
        sample = df[c].dropna().head(3).tolist()
        lines.append(f"- {c} ({df[c].dtype}) nulls={int(df[c].isna().sum())} "
                     f"unique={df[c].nunique()} sample={sample}")
    return {"profile": "\n".join(lines), "step": 0, "attempts": 0, "findings": [], "error": ""}


def plan_node(s: State) -> State:
    raw = ask(PLAN_SYS, f"Question: {s['question']}\n\nDataset profile:\n{s['profile']}")
    return {"plan": _json_list(raw)}


def code_node(s: State) -> State:
    label = s["plan"][s["step"]]
    done = "\n".join(f"- {f['step']}: {f['output'][:400]}" for f in s["findings"]) or "none yet"
    user = (f"Question: {s['question']}\n\nDataset profile:\n{s['profile']}\n\n"
            f"Already done:\n{done}\n\nCurrent step: {label}")
    if s.get("error"):
        user += (f"\n\nYour previous code failed.\nCode:\n{s['code']}\n\nError:\n{s['error']}\n\n"
                 "Fix the bug and return the full corrected code.")
    return {"code": _code_block(ask(CODE_SYS, user)), "step_label": label}


def execute_node(s: State) -> State:
    res = run_python(s["code"], s["run_dir"])
    if res.error:
        return {"error": res.error, "stdout": res.stdout, "attempts": s["attempts"] + 1, "new_charts": []}
    finding = {"step": s["step_label"], "output": res.stdout, "charts": res.charts, "failed": False}
    return {"error": "", "stdout": res.stdout, "attempts": 0, "new_charts": res.charts,
            "findings": s["findings"] + [finding], "step": s["step"] + 1}


def skip_node(s: State) -> State:
    """Out of retries: record the failure and move on instead of looping forever."""
    finding = {"step": s["step_label"], "output": f"FAILED after {MAX_FIXES} attempts: {s['error'][-300:]}",
               "charts": [], "failed": True}
    return {"error": "", "attempts": 0, "findings": s["findings"] + [finding], "step": s["step"] + 1}


def report_node(s: State) -> State:
    charts = [c for f in s["findings"] for c in f["charts"]]
    body = "\n\n".join(f"### {f['step']}\n{f['output']}" for f in s["findings"])
    user = (f"Question: {s['question']}\n\nFindings:\n{body}\n\nChart files: {charts or 'none'}")
    report = ask(REPORT_SYS, user, temperature=0.2)
    (Path(s["run_dir"]) / "report.md").write_text(report, encoding="utf-8")
    return {"report": report}


# ---------- routing ----------
def after_execute(s: State) -> str:
    if s.get("error"):
        return "code" if s["attempts"] < MAX_FIXES else "skip"
    return "code" if s["step"] < len(s["plan"]) else "report"


def after_skip(s: State) -> str:
    return "code" if s["step"] < len(s["plan"]) else "report"


def build_graph():
    g = StateGraph(State)
    for name, fn in [("profile", profile_node), ("plan", plan_node), ("code", code_node),
                     ("execute", execute_node), ("skip", skip_node), ("report", report_node)]:
        g.add_node(name, fn)
    g.add_edge(START, "profile")
    g.add_edge("profile", "plan")
    g.add_edge("plan", "code")
    g.add_edge("code", "execute")
    g.add_conditional_edges("execute", after_execute, {"code": "code", "skip": "skip", "report": "report"})
    g.add_conditional_edges("skip", after_skip, {"code": "code", "report": "report"})
    g.add_edge("report", END)
    return g.compile()


graph = build_graph()

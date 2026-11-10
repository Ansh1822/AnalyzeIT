"""Runs LLM-written Python away from the API process.

local  -> subprocess with a scrubbed environment (no API keys) and a timeout.
docker -> throwaway container, no network, 512 MB RAM, 1 CPU.
Prefer docker for anything beyond your own laptop.
"""
import os
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

# Prepended to every step so generated code can just use `df` and `save_chart`.
PRELUDE = '''import warnings; warnings.filterwarnings("ignore")
import os
import pandas as pd, numpy as np
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
os.makedirs("charts", exist_ok=True)
df = pd.read_csv("data.csv")
def save_chart(name):
    plt.tight_layout()
    plt.savefig(f"charts/{name}.png", dpi=130)
    plt.close()
'''


@dataclass
class Result:
    stdout: str = ""
    error: str = ""
    charts: list = field(default_factory=list)


def run_python(code: str, run_dir: str, timeout: int = 60) -> Result:
    run_dir = Path(run_dir)
    charts_dir = run_dir / "charts"
    charts_dir.mkdir(exist_ok=True)
    before = {p.name for p in charts_dir.glob("*.png")}

    (run_dir / "step.py").write_text(PRELUDE + "\n" + code, encoding="utf-8")

    if os.getenv("SANDBOX", "local") == "docker":
        cmd = ["docker", "run", "--rm", "--network", "none", "--memory", "512m", "--cpus", "1",
               "-v", f"{run_dir.resolve()}:/work", "-w", "/work",
               "analyst-sandbox", "python", "step.py"]
    else:
        cmd = [sys.executable, "step.py"]

    keep = ("PATH", "SYSTEMROOT", "TEMP", "TMP", "HOME", "USERPROFILE")
    env = {k: v for k, v in os.environ.items() if k in keep}
    env["PYTHONIOENCODING"] = "utf-8"

    try:
        p = subprocess.run(cmd, cwd=run_dir, capture_output=True, text=True,
                           timeout=timeout, env=env, encoding="utf-8", errors="replace")
    except subprocess.TimeoutExpired:
        return Result(error=f"Timed out after {timeout}s. Use less data or a cheaper method.")
    except FileNotFoundError as e:
        return Result(error=f"Sandbox runner not found: {e}")

    new = sorted({p_.name for p_ in charts_dir.glob("*.png")} - before)
    if p.returncode != 0:
        return Result(stdout=p.stdout[-3000:], error=p.stderr[-1500:], charts=new)
    return Result(stdout=p.stdout[-3000:], charts=new)

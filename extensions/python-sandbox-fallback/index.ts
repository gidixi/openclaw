import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawPluginApi } from "../../src/plugins/types.js";
import { resolveAgentWorkspaceDir } from "../../src/agents/agent-scope.js";
import { runCommandWithTimeout } from "../../src/process/exec.js";
import { resolveAgentIdFromSessionKey } from "../../src/routing/session-key.js";

type PythonSandboxFallbackConfig = {
  enabled?: boolean;
  autoSuggest?: boolean;
  maxRetries?: number;
};

// Embedded Python sandbox CLI script (generic, no hardcoded paths)
const SANDBOX_CLI_SCRIPT = `#!/usr/bin/env python3
"""Python Sandbox CLI for OpenClaw - Embedded version."""

import argparse
import sys
import subprocess
import json
import time
import os
from pathlib import Path

# Derive workspace root from script location:
# Script is at: workspace/tools/python-sandbox/scripts/sandbox_cli.py
# So workspace root is: __file__/../../../
_script_file = Path(__file__).resolve()
# Go up: scripts -> python-sandbox -> tools -> workspace
WORKSPACE_ROOT = _script_file.parent.parent.parent.parent
# Sandbox directory is in workspace root
SANDBOX_DIR = WORKSPACE_ROOT / "sandbox"

# Allow override via environment variables (for testing or custom setups)
if "SANDBOX_WORKSPACE_ROOT" in os.environ:
    WORKSPACE_ROOT = Path(os.environ["SANDBOX_WORKSPACE_ROOT"])
    SANDBOX_DIR = Path(os.environ.get("SANDBOX_DIR", str(WORKSPACE_ROOT / "sandbox")))
elif "SANDBOX_DIR" in os.environ:
    SANDBOX_DIR = Path(os.environ["SANDBOX_DIR"])


def ensure_sandbox():
    """Ensure the sandbox directory exists."""
    SANDBOX_DIR.mkdir(parents=True, exist_ok=True)
    return SANDBOX_DIR


def get_script_path(name):
    """Get the full path to a script, ensuring .py extension."""
    if not name.endswith('.py'):
        name = f"{name}.py"
    return SANDBOX_DIR / name


def init_sandbox():
    """Initialize the sandbox directory."""
    ensure_sandbox()
    return {"status": "ok", "message": f"Sandbox initialized at {SANDBOX_DIR}"}


def create_script(name, content=None):
    """Create a new Python script."""
    ensure_sandbox()
    script_path = get_script_path(name)
    
    if script_path.exists():
        return {"error": f"Script '{name}' already exists"}
    
    if content is None:
        content = "#!/usr/bin/env python3\\n\\"\\"\\"Temporary script created by sandbox-cli.\\"\\"\\"\\n\\n"
    
    script_path.write_text(content, encoding='utf-8')
    script_path.chmod(0o755)
    
    return {
        "status": "ok",
        "message": f"Script '{name}' created",
        "path": str(script_path)
    }


def write_script(name, content):
    """Write content to a script (creates if doesn't exist)."""
    ensure_sandbox()
    script_path = get_script_path(name)
    
    script_path.write_text(content, encoding='utf-8')
    script_path.chmod(0o755)
    
    return {
        "status": "ok",
        "message": f"Script '{name}' written",
        "path": str(script_path)
    }


def read_script(name):
    """Read and return a script's content."""
    ensure_sandbox()
    script_path = get_script_path(name)
    
    if not script_path.exists():
        return {"error": f"Script '{name}' not found"}
    
    content = script_path.read_text(encoding='utf-8')
    return {
        "status": "ok",
        "name": name,
        "content": content,
        "path": str(script_path)
    }


def run_script(name, args=None):
    """Execute a script."""
    ensure_sandbox()
    script_path = get_script_path(name)
    
    if not script_path.exists():
        return {"error": f"Script '{name}' not found"}
    
    try:
        cmd = [sys.executable, str(script_path)]
        if args:
            cmd.extend(args)
        
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=300
        )
        
        return {
            "status": "ok" if result.returncode == 0 else "error",
            "returncode": result.returncode,
            "stdout": result.stdout,
            "stderr": result.stderr,
            "script": name
        }
    except subprocess.TimeoutExpired:
        return {"error": f"Script '{name}' execution timed out"}
    except Exception as e:
        return {"error": f"Error executing script '{name}': {str(e)}"}


def list_scripts():
    """List all scripts in the sandbox."""
    ensure_sandbox()
    scripts = []
    
    for script_path in sorted(SANDBOX_DIR.glob("*.py")):
        stat = script_path.stat()
        scripts.append({
            "name": script_path.name,
            "size": stat.st_size,
            "modified": stat.st_mtime,
            "path": str(script_path)
        })
    
    return {
        "status": "ok",
        "scripts": scripts,
        "count": len(scripts)
    }


def delete_script(name):
    """Delete a script."""
    ensure_sandbox()
    script_path = get_script_path(name)
    
    if not script_path.exists():
        return {"error": f"Script '{name}' not found"}
    
    try:
        script_path.unlink()
        return {
            "status": "ok",
            "message": f"Script '{name}' deleted"
        }
    except Exception as e:
        return {"error": f"Error deleting script '{name}': {str(e)}"}


def clean_sandbox(all_scripts=False, days=None, hours=None):
    """Clean the sandbox by deleting scripts."""
    ensure_sandbox()
    deleted = []
    errors = []
    current_time = time.time()
    
    for script_path in SANDBOX_DIR.glob("*.py"):
        should_delete = False
        
        if all_scripts:
            should_delete = True
        elif days is not None:
            script_age = current_time - script_path.stat().st_mtime
            age_days = script_age / (24 * 3600)
            if age_days >= days:
                should_delete = True
        elif hours is not None:
            script_age = current_time - script_path.stat().st_mtime
            age_hours = script_age / 3600
            if age_hours >= hours:
                should_delete = True
        
        if should_delete:
            try:
                script_path.unlink()
                deleted.append(script_path.name)
            except Exception as e:
                errors.append({"script": script_path.name, "error": str(e)})
    
    result = {
        "status": "ok",
        "deleted_count": len(deleted),
        "deleted_scripts": deleted
    }
    
    if errors:
        result["errors"] = errors
        result["error_count"] = len(errors)
    
    if not deleted and not errors:
        result["message"] = "No scripts to clean"
    else:
        result["message"] = f"Cleaned {len(deleted)} script(s)"
    
    return result


def main():
    parser = argparse.ArgumentParser(description="Python Sandbox CLI")
    sub = parser.add_subparsers(dest="cmd", required=True)
    
    sub.add_parser("init", help="Initialize the sandbox directory")
    
    create = sub.add_parser("create", help="Create a new Python script")
    create.add_argument("name", help="Script name (without .py extension)")
    create.add_argument("--content", help="Initial content (optional)")
    
    write = sub.add_parser("write", help="Write content to a script")
    write.add_argument("name", help="Script name (without .py extension)")
    write.add_argument("--content", help="Content to write (if not provided, reads from stdin)")
    
    read = sub.add_parser("read", help="Read a script's content")
    read.add_argument("name", help="Script name (without .py extension)")
    
    run = sub.add_parser("run", help="Execute a script")
    run.add_argument("name", help="Script name (without .py extension)")
    run.add_argument("args", nargs=argparse.REMAINDER, help="Arguments to pass to the script")
    
    sub.add_parser("list", help="List all scripts")
    
    delete = sub.add_parser("delete", help="Delete a script")
    delete.add_argument("name", help="Script name (without .py extension)")
    
    clean = sub.add_parser("clean", help="Clean the sandbox (delete scripts)")
    clean_group = clean.add_mutually_exclusive_group(required=True)
    clean_group.add_argument("--all", action="store_true", help="Delete all scripts")
    clean_group.add_argument("--days", type=int, help="Delete scripts older than N days")
    clean_group.add_argument("--hours", type=int, help="Delete scripts older than N hours")
    
    args = parser.parse_args()
    
    if args.cmd == "init":
        resp = init_sandbox()
    elif args.cmd == "create":
        resp = create_script(args.name, args.content)
    elif args.cmd == "write":
        if args.content:
            content = args.content
        else:
            content = sys.stdin.read()
        resp = write_script(args.name, content)
    elif args.cmd == "read":
        resp = read_script(args.name)
    elif args.cmd == "run":
        resp = run_script(args.name, args.args if args.args else None)
    elif args.cmd == "list":
        resp = list_scripts()
    elif args.cmd == "delete":
        resp = delete_script(args.name)
    elif args.cmd == "clean":
        resp = clean_sandbox(
            all_scripts=args.all if hasattr(args, 'all') else False,
            days=args.days if hasattr(args, 'days') and args.days else None,
            hours=args.hours if hasattr(args, 'hours') and args.hours else None
        )
    else:
        resp = {"error": "Unknown command"}
    
    print(json.dumps(resp, indent=2))
    
    if "error" in resp:
        sys.exit(1)


if __name__ == "__main__":
    main()
`;

/**
 * Ensures the embedded sandbox CLI script exists in the workspace and returns its path.
 * Creates it if it doesn't exist.
 */
async function ensureSandboxCliScript(workspaceDir: string): Promise<string> {
  const cliDir = path.join(workspaceDir, "tools", "python-sandbox", "scripts");
  const cliPath = path.join(cliDir, "sandbox_cli.py");

  try {
    // Check if it already exists
    const stat = await fs.stat(cliPath);
    if (stat.isFile()) {
      return cliPath;
    }
  } catch {
    // File doesn't exist, create it
  }

  // Create directory structure
  await fs.mkdir(cliDir, { recursive: true });

  // Write the embedded script
  await fs.writeFile(cliPath, SANDBOX_CLI_SCRIPT, { encoding: "utf-8", mode: 0o755 });

  return cliPath;
}

function buildPythonSandboxInstructions(sandboxCliPath: string, sandboxDir: string): string {
  return `
## Python Sandbox & Advanced CLI Fallback Strategy

When standard tools, commands, or operations fail or are insufficient, you have two escalation paths:
1. **Advanced CLI combinations** — pipe chains, subshells, process substitution, parallel execution
2. **Python sandbox** — for anything beyond CLI capabilities

### Escalation Order

Always follow this order:
1. **Simple command** — try the obvious tool first
2. **Advanced CLI combo** — pipe chains, xargs, awk, parallel, subshells
3. **Python sandbox** — when CLI is too complex or limited

---

### Advanced CLI Combinations

Before jumping to Python, try powerful CLI patterns:

**Pipe chains with error handling:**
\`\`\`bash
cmd1 2>/dev/null | cmd2 || { echo "fallback"; cmd3; }
\`\`\`

**Parallel execution with xargs:**
\`\`\`bash
find . -name "*.log" -print0 | xargs -0 -P4 -I{} sh -c 'gzip "{}" && echo "done: {}"'
\`\`\`

**Process substitution for comparing outputs:**
\`\`\`bash
diff <(curl -s api1/data | jq '.items[]') <(curl -s api2/data | jq '.items[]')
\`\`\`

**Multi-step with temp files and cleanup:**
\`\`\`bash
tmp=$(mktemp) && trap "rm -f $tmp" EXIT && cmd1 > "$tmp" && cmd2 < "$tmp"
\`\`\`

**Conditional chains:**
\`\`\`bash
command -v jq &>/dev/null && jq '.key' file.json || python3 -c "import json,sys;print(json.load(sys.stdin)['key'])" < file.json
\`\`\`

**Awk/sed for structured data:**
\`\`\`bash
docker stats --no-stream --format '{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}' | awk -F'\\t' '$2+0 > 80 {print "HIGH CPU:", $1, $2}'
\`\`\`

**Loop with retries:**
\`\`\`bash
for i in 1 2 3; do curl -sf http://service/health && break || sleep $((i*2)); done
\`\`\`

**Aggregate and report:**
\`\`\`bash
{ echo "=== Disk ==="; df -h /; echo "=== Memory ==="; free -h; echo "=== Load ==="; uptime; } 2>&1 | tee /tmp/status.txt
\`\`\`

---

### When to Use Python Sandbox Instead of CLI

Use python-sandbox when:
- Data requires parsing beyond awk/jq (nested JSON, XML, CSV joins, binary)
- You need HTTP requests with auth, headers, retries, pagination
- Complex math, statistics, or data transformations
- Working with databases, SQLite, or structured queries
- Multi-step logic with branching that would be unreadable in bash
- You need Python libraries (pandas, requests, etc.)
- String processing beyond regex (NLP, fuzzy matching, encoding)
- Generating reports, charts, or formatted output
- The CLI equivalent would exceed ~3 piped commands and be fragile

### How to Use Python Sandbox

The python-sandbox tool is located at: \`${sandboxCliPath}\`
Scripts are stored in: \`${sandboxDir}\`

**Quick workflow:**
\`\`\`bash
# Write script
cat <<'PYEOF' | python3 ${sandboxCliPath} write <script_name>
#!/usr/bin/env python3
import sys, json

data = json.load(sys.stdin)
result = [item * 2 for item in data]
print(json.dumps(result, indent=2))
PYEOF

# Execute
echo '[1, 2, 3]' | python3 ${sandboxCliPath} run <script_name>
\`\`\`

**With arguments and error handling:**
\`\`\`bash
cat <<'PYEOF' | python3 ${sandboxCliPath} write fetch_api
#!/usr/bin/env python3
import sys, json, urllib.request, urllib.error

url = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8080/api/status"
retries = int(sys.argv[2]) if len(sys.argv) > 2 else 3

for attempt in range(retries):
    try:
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
            print(json.dumps(data, indent=2))
            sys.exit(0)
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"Attempt {attempt+1}/{retries} failed: {e}", file=sys.stderr)
        if attempt == retries - 1:
            sys.exit(1)
        import time; time.sleep(2 ** attempt)
PYEOF

python3 ${sandboxCliPath} run fetch_api "http://api.example.com/data" 3
\`\`\`

### Automatic Fallback Behavior

**If a tool or command fails:**
1. Don't just report the error
2. Check if an advanced CLI combination could solve it
3. If CLI is not enough, immediately create and execute a Python script
4. Report the result, not the failure

**If standard tools are insufficient:**
1. Don't ask for permission — escalate automatically
2. Try CLI combo first, then Python sandbox
3. Execute and report results

The python-sandbox skill documentation is available at: \`skills/python-sandbox/SKILL.md\`
`;
}

// Known tool names that indicate python-sandbox usage
const SANDBOX_TOOL_PATTERNS = ["sandbox", "python", "py_exec", "script_run"];

// Tools that commonly fail and benefit from fallback
const FALLBACK_CANDIDATES = [
  "bash",
  "shell",
  "exec",
  "run_command",
  "terminal",
  "curl",
  "wget",
  "http",
  "api_call",
  "fetch",
  "file_read",
  "file_write",
  "file_parse",
  "grep",
  "find",
  "awk",
  "sed",
  "jq",
];

function isSandboxCall(toolName?: string): boolean {
  if (!toolName) return false;
  const lower = toolName.toLowerCase();
  return SANDBOX_TOOL_PATTERNS.some((p) => lower.includes(p));
}

function isFallbackCandidate(toolName?: string): boolean {
  if (!toolName) return true; // unknown tools are candidates
  const lower = toolName.toLowerCase();
  return FALLBACK_CANDIDATES.some((p) => lower.includes(p));
}

export default function register(api: OpenClawPluginApi) {
  const cfg = (api.pluginConfig ?? {}) as PythonSandboxFallbackConfig;

  if (cfg.enabled === false) {
    api.logger.info("python-sandbox-fallback: plugin disabled");
    return;
  }

  if (cfg.autoSuggest === false) {
    api.logger.info("python-sandbox-fallback: auto-suggest disabled");
    return;
  }

  const maxRetries = cfg.maxRetries ?? 2;

  api.logger.info("python-sandbox-fallback: registering hooks");

  // Track consecutive failures per session to escalate strategy
  const failureCounts = new Map<string, number>();

  api.on("before_agent_start", async (_event, ctx) => {
    try {
      const agentId = ctx.agentId ?? resolveAgentIdFromSessionKey(ctx.sessionKey ?? "");
      const workspaceDir = ctx.workspaceDir ?? resolveAgentWorkspaceDir(api.config, agentId);

      if (!workspaceDir) return;

      // Ensure the embedded sandbox CLI script exists (creates it if needed)
      const cliPath = await ensureSandboxCliScript(workspaceDir);

      // Verify it was created successfully
      try {
        const cliStat = await fs.stat(cliPath);
        if (!cliStat.isFile()) {
          api.logger.warn("python-sandbox-fallback: failed to create sandbox_cli.py");
          return;
        }
      } catch (err) {
        api.logger.warn(
          `python-sandbox-fallback: failed to verify sandbox_cli.py: ${err instanceof Error ? err.message : String(err)}`,
        );
        return;
      }

      // Build instructions with workspace-specific paths
      const sandboxDir = path.join(workspaceDir, "sandbox");
      const instructions = buildPythonSandboxInstructions(cliPath, sandboxDir);

      return { prependContext: instructions.trim() };
    } catch (err) {
      api.logger.warn(
        `python-sandbox-fallback: error in before_agent_start: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
  });

  api.on("after_tool_call", async (event, ctx) => {
    try {
      if (!event.error) {
        // Reset failure count on success
        const key = ctx.sessionKey ?? "default";
        failureCounts.delete(key);
        return;
      }

      // Skip if already a sandbox call — avoid infinite loops
      if (isSandboxCall(event.toolName)) {
        api.logger.debug?.(
          "python-sandbox-fallback: sandbox call itself failed, not re-escalating",
        );
        return;
      }

      const key = ctx.sessionKey ?? "default";
      const count = (failureCounts.get(key) ?? 0) + 1;
      failureCounts.set(key, count);

      const toolInfo = event.toolName ?? "unknown";
      // event.error is typed as string | undefined in PluginHookAfterToolCallEvent
      const errorMsg = event.error ?? "unknown error";

      api.logger.info(
        `python-sandbox-fallback: tool "${toolInfo}" failed (attempt ${count}/${maxRetries}): ${errorMsg}`,
      );

      // After maxRetries consecutive failures, log escalation hint
      if (count >= maxRetries && isFallbackCandidate(event.toolName)) {
        api.logger.info(
          `python-sandbox-fallback: ${count} consecutive failures on "${toolInfo}" — agent should escalate to CLI combo or python-sandbox`,
        );
        // The system prompt instructions guide the agent to auto-escalate
      }
    } catch (err) {
      api.logger.warn(
        `python-sandbox-fallback: error in after_tool_call: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}

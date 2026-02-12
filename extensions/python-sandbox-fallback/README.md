# Python Sandbox Fallback Extension

This extension automatically instructs the agent to use the python-sandbox skill when standard tools fail or are insufficient.

## Features

- **Automatic System Prompt Enhancement**: Adds instructions to the system prompt about when and how to use python-sandbox
- **Fallback Strategy**: Guides the agent to automatically create and execute Python scripts when standard tools cannot accomplish a task
- **Non-Intrusive**: Only activates when the python-sandbox skill exists in the workspace

## Configuration

Add to your `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "python-sandbox-fallback": {
        "enabled": true,
        "autoSuggest": true
      }
    }
  }
}
```

### Options

- `enabled` (boolean, default: `true`): Enable or disable the plugin
- `autoSuggest` (boolean, default: `true`): Automatically add python-sandbox instructions to system prompt

## How It Works

1. **Before Agent Start**: Checks if `skills/python-sandbox/SKILL.md` exists in the workspace
2. **System Prompt Enhancement**: If the skill exists, adds detailed instructions about:
   - When to use python-sandbox (tool failures, complex operations, etc.)
   - How to use the sandbox CLI tool
   - Automatic fallback behavior
3. **Tool Failure Monitoring**: Logs tool failures for debugging (doesn't interfere with agent flow)

## Requirements

- The python-sandbox skill must exist at: `workspace/skills/python-sandbox/SKILL.md`
- The sandbox CLI tool must exist at: `workspace/tools/python-sandbox/scripts/sandbox_cli.py`

## Behavior

When enabled, the agent will:

- Automatically consider using python-sandbox when standard tools fail
- Create Python scripts without asking for permission when appropriate
- Execute scripts and report results instead of just reporting failures
- Use python-sandbox for complex data processing, API interactions, and operations that require Python libraries

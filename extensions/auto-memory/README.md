# Auto-Memory Plugin

Plugin for OpenClaw that automatically writes important facts extracted from conversations to memory files (`memory/YYYY-MM-DD.md`).

## Features

- **Automatic analysis**: Analyzes conversations to extract important facts, decisions, and preferences
- **Periodic writing**: Writes to memory every N messages (configurable, default: 5)
- **Notifications**: Notifies the user in chat when memory is updated
- **Importance filtering**: Only saves facts with importance above a configured threshold
- **Model-aware**: Uses the primary model from your config (no hardcoded provider/model)

## Configuration

Add the configuration in `openclaw.json`:

```json
{
  "plugins": {
    "@openclaw/auto-memory": {
      "enabled": true,
      "messageThreshold": 5,
      "minImportance": 0.7,
      "notificationEnabled": true,
      "notificationMessage": "💾 Memory updated"
    }
  }
}
```

### Options

- `enabled` (boolean, default: `true`): Enable/disable the plugin
- `messageThreshold` (number, default: `5`): Number of messages after which to analyze and write to memory
- `minImportance` (number, default: `0.7`): Minimum importance threshold (0-1) for facts to be saved
- `notificationEnabled` (boolean, default: `true`): Whether to send a notification when memory is updated
- `notificationMessage` (string, default: `"💾 Memory updated"`): Message to send as notification

## How it works

1. The plugin registers an `agent_end` hook that is called after each agent execution
2. It counts processed messages per session
3. When it reaches the configured threshold (`messageThreshold`), it analyzes the conversation using the LLM
4. It resolves the model from your config's `agents.defaults.model.primary` setting
5. It extracts important facts, decisions, and preferences
6. It writes the facts to `memory/YYYY-MM-DD.md` organized by category
7. It sends a notification to the user in the current chat

## Memory format

Facts are written to `memory/YYYY-MM-DD.md` in the following format:

```markdown
# 2026-02-08

## 02:30 PM

### Decisions

- Decided to use PostgreSQL for the new project

### Preferences

- User prefers to receive notifications via email

### Facts

- The project must be completed by end of month
```

## Categories

Facts are categorized as:

- **Decisions**: Decisions made during the conversation
- **Preferences**: User preferences
- **Personal Information**: Relevant personal information
- **Facts**: Other important facts

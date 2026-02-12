# Auto-Memory Plugin

Plugin for OpenClaw that automatically extracts important facts from conversations and stores them in LanceDB with local embeddings for semantic search. **This plugin only works with embeddings - it does not write to Markdown files.**

## Features

- **Embedding-only storage**: Stores memories in LanceDB with local embeddings (no Markdown files)
- **Automatic analysis**: Analyzes conversations to extract important facts, decisions, and preferences
- **Periodic processing**: Processes conversations every N messages (configurable, default: 5)
- **Notifications**: Notifies the user in chat when memory is updated
- **Importance filtering**: Only saves facts with importance above a configured threshold
- **Model-aware**: Uses the primary model from your config for analysis (no hardcoded provider/model)
- **LanceDB integration**: Stores embeddings in LanceDB for semantic search (required)
- **Local embeddings**: Uses node-llama-cpp with lightweight CPU models for offline embedding generation (required)

## Configuration

Add the configuration in `openclaw.json`:

```json
{
  "plugins": {
    "entries": {
      "auto-memory": {
        "enabled": true,
        "messageThreshold": 5,
        "minImportance": 0.7,
        "notificationEnabled": true,
        "notificationMessage": "💾 Memory updated",
        "lancedb": {
          "dbPath": "~/.openclaw/memory/auto-memory-lancedb"
        },
        "embedding": {
          "modelPath": "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf",
          "modelCacheDir": "~/.cache/openclaw/models"
        }
      }
    }
  }
}
```

### Options

- `enabled` (boolean, default: `true`): Enable/disable the plugin
- `messageThreshold` (number, default: `5`): Number of messages after which to analyze and store in LanceDB
- `minImportance` (number, default: `0.7`): Minimum importance threshold (0-1) for facts to be saved
- `notificationEnabled` (boolean, default: `true`): Whether to send a notification when memory is updated
- `notificationMessage` (string, default: `"💾 Memory updated"`): Message to send as notification
- `maxMessagesContext` (number, default: `30`): Maximum number of recent messages to include in analysis
- `lancedb.dbPath` (string, default: `~/.openclaw/memory/auto-memory-lancedb`): Path to LanceDB database (required)
- `embedding.modelPath` (string, default: `hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf`): Path to embedding model (GGUF format or HuggingFace URI) (required)
- `embedding.modelCacheDir` (string, optional): Directory to cache downloaded models

**Note**: LanceDB and embeddings are **required**. If they cannot be initialized, the plugin will be disabled.

## How it works

1. The plugin registers an `agent_end` hook that is called after each agent execution
2. It counts processed messages per session
3. When it reaches the configured threshold (`messageThreshold`), it analyzes the conversation using the LLM
4. It resolves the model from your config's `agents.defaults.model.primary` setting
5. It extracts important facts, decisions, and preferences
6. **For each fact:**
   - Generates an embedding locally using node-llama-cpp with a lightweight CPU model
   - Stores the fact with its embedding in LanceDB for semantic search
7. It sends a notification to the user in the current chat

**Important**: This plugin does NOT write to Markdown files. All memories are stored only in LanceDB with embeddings.

## Storage format

Facts are stored in LanceDB with the following structure:

- **id**: Unique identifier (UUID)
- **text**: The fact text
- **vector**: 768-dimensional embedding vector (from embeddinggemma-300M)
- **importance**: Importance score (0-1)
- **category**: One of "decision", "preference", "fact", "personal_info"
- **createdAt**: Timestamp when stored

Memories can be searched semantically using vector similarity search in LanceDB.

## Categories

Facts are categorized as:

- **Decisions**: Decisions made during the conversation
- **Preferences**: User preferences
- **Personal Information**: Relevant personal information
- **Facts**: Other important facts

## LanceDB and Local Embeddings

The plugin **requires** LanceDB and local embeddings to function:

- **LanceDB**: Vector database for storing and searching embeddings (required)
- **Local Embeddings**: Uses `node-llama-cpp` with lightweight CPU models (default: `embeddinggemma-300M`) (required)
- **Offline Operation**: No API keys required - everything runs locally
- **Automatic Storage**: Facts are automatically embedded and stored in LanceDB
- **No File Writing**: This plugin does not write to Markdown files - all storage is in LanceDB

### Requirements

- Node.js 22 LTS (required for node-llama-cpp)
- `node-llama-cpp` package (installed automatically with OpenClaw) - **required**
- `@lancedb/lancedb` package (installed automatically with the plugin) - **required**

**If these requirements are not met, the plugin will not initialize and will be disabled.**

### Model Selection

The default model (`embeddinggemma-300M-Q8_0`) is optimized for CPU usage and produces 768-dimensional vectors. You can use any GGUF embedding model by specifying `embedding.modelPath`.

### Performance

- **First run**: Model download may take a few minutes (~300MB)
- **Subsequent runs**: Model is cached locally
- **Embedding speed**: ~50-200ms per fact on modern CPUs
- **Storage**: LanceDB uses efficient columnar storage with automatic indexing

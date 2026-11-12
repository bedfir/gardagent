# OpenAI SDK through Gardagent

Complete the root README local quickstart first; keep `GA_KEY` in the same shell.
From the repository root, with Python 3 and its venv module installed:

```bash
python3 -m venv /tmp/gardagent-openai
/tmp/gardagent-openai/bin/pip install openai==1.109.1
/tmp/gardagent-openai/bin/python examples/openai/main.py
```

The SDK posts to `/v1/chat/completions`; Ollama answers through the gateway.
Inspect `/admin/ledger` with the admin token as shown in the quickstart.
Only the agent key goes into the SDK. No provider key is needed.

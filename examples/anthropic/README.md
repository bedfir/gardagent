# Anthropic SDK through Gardagent — format-compatible

Complete the root README local quickstart first; keep `GA_KEY` in the same shell.
From the repository root, with Python 3 and its venv module installed:

```bash
python3 -m venv /tmp/gardagent-anthropic
/tmp/gardagent-anthropic/bin/pip install anthropic==0.67.0
/tmp/gardagent-anthropic/bin/python examples/anthropic/main.py
```

The SDK posts to `/v1/messages`. The local Compose profile routes this endpoint to
a synthetic fixture returning a fixed message and usage counts. This demonstrates
SDK format, authentication and journaling without a provider key. It does not test
Anthropic inference or establish provider compatibility. Status: format-compatible;
real-provider verification remains pending (see `tools/anthropic/README.md`).
Inspect `/admin/ledger` as in the quickstart. For an independently operated upstream,
configure `ANTHROPIC_UPSTREAM_BASE_URL` and `ANTHROPIC_UPSTREAM_API_KEY` on the gateway;
the SDK continues to use only the agent key. The local `demo-anthropic` accounting rate is zero.

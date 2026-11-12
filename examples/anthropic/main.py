import os
from anthropic import Anthropic

# Format-compatible demonstration with the local synthetic fixture, not a provider test.
client = Anthropic(base_url="http://127.0.0.1:8080", api_key=os.environ["GA_KEY"])
response = client.messages.create(
    model="demo-anthropic", max_tokens=64,
    messages=[{"role": "user", "content": "Say hello."}],
)
print(response.content)

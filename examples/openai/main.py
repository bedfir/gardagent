import os
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8080/v1", api_key=os.environ["GA_KEY"])
response = client.chat.completions.create(
    model="qwen2.5:0.5b", max_tokens=64,
    messages=[{"role": "user", "content": "Say hello in one sentence."}],
)
print(response.choices[0].message.content)

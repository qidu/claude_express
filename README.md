# Install npm
```
sudo npm install express cors node-fetch
```

# Run the Proxy
```
node index.js
```

# ENV for Claude Code
```
export ANTHROPIC_BASE_URL=http://localhost:8787
export API_TIMEOUT_MS=610000
export ANTHROPIC_MODEL=haiku
export ANTHROPIC_SMALL_FAST_MODEL=haiku
#export ANTHROPIC_AUTH_TOKEN=sk-d8d563c410cd87a6c29dc81bf983aa935a16fe27166a8eb0444c1324ec******
```

# Run Claude Code
```
Claude "hi"
```

# Test with curl
```
curl -X POST http://localhost:8787/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: your_api_key" \
  -d '{
    "model": "haiku",
    "messages": [
      {
        "role": "user",
        "content": "Hello, how are you?"
      }
    ],
    "max_tokens": 100
  }'
```

# Create Image
```
sudo docker build -t claude_express .
```
```
sudo docker run -it --rm -p 8787:8787 claude_express
```

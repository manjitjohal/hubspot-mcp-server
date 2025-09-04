#!/bin/sh

# Railway startup script
echo "[RAILWAY] Starting web service on port $PORT"

# Ensure PORT is set
if [ -z "$PORT" ]; then
  export PORT=3000
  echo "[RAILWAY] No PORT env var, defaulting to 3000"
fi

echo "[RAILWAY] Starting Node.js application..."

# Start the Node.js server
exec node index.js
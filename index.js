const http = require('http');
const { spawn } = require('child_process');
const readline = require('readline');

// Railway port
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

// Store MCP process reference
let mcpProcess = null;
let mcpReady = false;

console.log(`Starting HTTP bridge on ${HOST}:${PORT}...`);

// Function to send request to MCP server and get response
async function sendToMCP(request) {
  return new Promise((resolve, reject) => {
    if (!mcpProcess || !mcpReady) {
      reject(new Error('MCP server not ready'));
      return;
    }
    
    // Create readline interface to read response
    const rl = readline.createInterface({
      input: mcpProcess.stdout,
      crlfDelay: Infinity
    });
    
    let responseData = '';
    
    rl.on('line', (line) => {
      responseData = line;
      rl.close();
    });
    
    rl.on('close', () => {
      try {
        const response = JSON.parse(responseData);
        resolve(response);
      } catch (error) {
        reject(new Error('Invalid JSON response from MCP server'));
      }
    });
    
    // Send request to MCP server
    mcpProcess.stdin.write(JSON.stringify(request) + '\n');
    
    // Timeout after 5 seconds
    setTimeout(() => {
      rl.close();
      reject(new Error('MCP server timeout'));
    }, 5000);
  });
}

// Create HTTP server that proxies to MCP server
const server = http.createServer((req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Railway health check - must respond quickly
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'ok', 
      message: 'HubSpot MCP Server is running',
      mcpReady: mcpReady,
      timestamp: new Date().toISOString()
    }));
    return;
  }
  
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      name: 'HubSpot MCP Server',
      version: '1.0.0',
      status: mcpReady ? 'running' : 'starting',
      endpoints: {
        health: '/health',
        mcp: '/mcp'
      }
    }));
    return;
  }
  
  if (req.method === 'POST' && req.url === '/mcp') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        
        // If MCP server is ready, forward the request
        if (mcpReady) {
          try {
            const response = await sendToMCP(request);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(response));
          } catch (error) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              jsonrpc: '2.0',
              error: { 
                code: -32603, 
                message: 'Internal error: ' + error.message 
              },
              id: request.id || null
            }));
          }
        } else {
          // Return initialization response if called with initialize method
          if (request.method === 'initialize') {
            const initResponse = {
              jsonrpc: '2.0',
              result: {
                protocolVersion: '2024-11-05',
                serverInfo: {
                  name: 'HubSpot MCP Server',
                  version: '1.0.0'
                },
                capabilities: {
                  tools: {
                    list: true,
                    call: true
                  }
                }
              },
              id: request.id || 1
            };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(initResponse));
          } else {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ 
              jsonrpc: '2.0',
              error: { 
                code: -32603, 
                message: 'MCP server is starting, please wait' 
              },
              id: request.id || null
            }));
          }
        }
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          jsonrpc: '2.0',
          error: { 
            code: -32700, 
            message: 'Parse error' 
          },
          id: null
        }));
      }
    });
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

// Start HTTP server first
server.listen(PORT, HOST, () => {
  console.log(`✅ HTTP bridge server listening on ${HOST}:${PORT}`);
  console.log(`✅ Railway should now be able to reach this server`);
  
  // Start the actual MCP server
  console.log('Starting HubSpot MCP server...');
  mcpProcess = spawn('npx', ['@hubspot/mcp-server'], {
    env: { ...process.env, HUBSPOT_ACCESS_TOKEN: process.env.HUBSPOT_ACCESS_TOKEN || '' },
    stdio: ['pipe', 'pipe', 'pipe']
  });
  
  // Handle MCP server stdout
  mcpProcess.stdout.on('data', (data) => {
    const output = data.toString();
    console.log('MCP stdout:', output);
    
    // Check if this is a successful initialization response
    try {
      const response = JSON.parse(output);
      if (response.id === 1 && response.result && response.result.protocolVersion) {
        mcpReady = true;
        console.log('✅ MCP server initialized successfully');
        
        // Send initialized notification
        const initializedNotification = {
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        };
        mcpProcess.stdin.write(JSON.stringify(initializedNotification) + '\n');
      }
    } catch (e) {
      // Not JSON, check for other ready indicators
      if (output.includes('Server connected') || output.includes('ready')) {
        console.log('MCP server appears ready');
      }
    }
  });
  
  // Handle MCP server stderr
  mcpProcess.stderr.on('data', (data) => {
    console.error('MCP stderr:', data.toString());
  });
  
  mcpProcess.on('error', (error) => {
    console.error('MCP server error:', error);
    mcpReady = false;
  });
  
  mcpProcess.on('exit', (code) => {
    console.log(`MCP server exited with code ${code}`);
    mcpReady = false;
    // Don't auto-restart to avoid infinite loops
    // The container orchestrator should handle restarts
  });
  
  // Send initialization request to MCP server
  setTimeout(() => {
    if (mcpProcess && !mcpReady) {
      console.log('Sending initialization to MCP server...');
      const initRequest = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'http-bridge',
            version: '1.0.0'
          }
        },
        id: 1
      };
      mcpProcess.stdin.write(JSON.stringify(initRequest) + '\n');
    }
  }, 2000);
});

// Keep the process alive and log health status
setInterval(() => {
  console.log(`Health check: Server running, MCP ready: ${mcpReady}`);
}, 30000);

// Track if we're shutting down
let isShuttingDown = false;

// Handle shutdown gracefully
process.on('SIGTERM', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('Received SIGTERM, shutting down gracefully...');
  
  // Give time for graceful shutdown
  setTimeout(() => {
    if (mcpProcess) {
      mcpProcess.kill();
    }
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  }, 100);
});

process.on('SIGINT', () => {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log('Received SIGINT, shutting down gracefully...');
  
  setTimeout(() => {
    if (mcpProcess) {
      mcpProcess.kill();
    }
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  }, 100);
});

// Prevent process from exiting on uncaught errors
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});
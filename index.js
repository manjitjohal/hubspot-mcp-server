const http = require('http');
const { spawn } = require('child_process');

// Railway port
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

console.log(`Starting HTTP bridge on ${HOST}:${PORT}...`);

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
  
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', message: 'HubSpot MCP Server is running' }));
    return;
  }
  
  if (req.method === 'GET' && req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      name: 'HubSpot MCP Server',
      version: '1.0.0',
      status: 'running',
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
    
    req.on('end', () => {
      // For now, return a mock MCP response to test if Railway can reach us
      const mockResponse = {
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
        id: 1
      };
      
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mockResponse));
    });
    return;
  }
  
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, HOST, () => {
  console.log(`✅ HTTP bridge server listening on ${HOST}:${PORT}`);
  console.log(`✅ Railway should now be able to reach this server`);
  
  // Start the actual MCP server in the background
  console.log('Starting HubSpot MCP server in background...');
  const mcpProcess = spawn('npx', ['@hubspot/mcp-server'], {
    env: process.env,
    stdio: 'inherit'
  });
  
  mcpProcess.on('error', (error) => {
    console.error('MCP server error:', error);
  });
});

// Handle shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  server.close();
  process.exit(0);
});
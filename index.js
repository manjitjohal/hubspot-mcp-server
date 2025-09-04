const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// CRITICAL: Use Railway's PORT environment variable
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Log startup immediately
console.log(`[STARTUP] Initializing HubSpot API Bridge...`);
console.log(`[STARTUP] PORT=${PORT}, HOST=${HOST}`);
console.log(`[STARTUP] Environment: NODE_ENV=${process.env.NODE_ENV}, DYNO=${process.env.DYNO}`);

// Simple in-memory cache for API responses
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Helper to call HubSpot MCP server CLI
async function callMCPServer(method, params = {}) {
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  
  // Check cache
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  
  try {
    // Build the command to execute
    const request = {
      jsonrpc: '2.0',
      method: method,
      params: params,
      id: Date.now()
    };
    
    // For now, return mock data until we implement proper MCP communication
    const mockResponse = {
      success: true,
      method: method,
      params: params,
      message: 'HubSpot MCP Server Bridge is running',
      timestamp: new Date().toISOString()
    };
    
    // Cache the response
    cache.set(cacheKey, {
      data: mockResponse,
      timestamp: Date.now()
    });
    
    return mockResponse;
  } catch (error) {
    console.error('Error calling MCP server:', error);
    throw error;
  }
}

// Create HTTP server
const server = http.createServer((req, res) => {
  // CRITICAL: Health check must respond IMMEDIATELY
  if (req.url === '/' || req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    return;
  }
  
  // Set CORS headers for other requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  // Log non-health requests
  if (!req.url.includes('/health')) {
    console.log(`[REQUEST] ${req.method} ${req.url}`);
  }
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Detailed status endpoint
  if (req.method === 'GET' && req.url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy',
      service: 'HubSpot MCP Server Bridge',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: process.memoryUsage(),
      hasToken: !!process.env.PRIVATE_APP_ACCESS_TOKEN || !!process.env.HUBSPOT_ACCESS_TOKEN,
      environment: {
        port: PORT,
        node: process.version
      }
    }));
    return;
  }
  
  // API info endpoint
  if (req.method === 'GET' && req.url === '/api') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      name: 'HubSpot MCP Server Bridge',
      version: '1.0.0',
      endpoints: {
        health: 'GET /health',
        api: 'GET /api',
        tools: 'GET /api/tools',
        call: 'POST /api/call'
      },
      description: 'HTTP bridge for HubSpot MCP Server'
    }));
    return;
  }
  
  // List available tools
  if (req.method === 'GET' && req.url === '/api/tools') {
    callMCPServer('tools/list')
      .then(tools => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tools));
      })
      .catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
      });
    return;
  }
  
  // Call a tool
  if (req.method === 'POST' && req.url === '/api/call') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', () => {
      try {
        const request = JSON.parse(body);
        callMCPServer('tools/call', request)
          .then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          })
          .catch(error => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
          });
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: error.message || 'Invalid request'
        }));
      }
    });
    return;
  }
  
  // 404 for unknown routes
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ 
    error: 'Not found',
    path: req.url,
    method: req.method
  }));
});

// Configure server
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;

// CRITICAL: Start server with callback to ensure Railway knows it's ready
server.listen(PORT, HOST, () => {
  console.log(`[READY] Server listening on http://${HOST}:${PORT}`);
  console.log(`[READY] PID: ${process.pid}`);
  console.log(`[READY] Health check: http://${HOST}:${PORT}/health`);
  
  // Check HubSpot token
  const hasToken = process.env.PRIVATE_APP_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  if (hasToken) {
    console.log('[READY] HubSpot access token configured');
  }
  
  // Send ready signal to stdout (Railway might be looking for this)
  console.log('Server is ready to accept connections');
});

// Handle server errors
server.on('error', (err) => {
  console.error('[ERROR] Server error:', err);
  if (err.code === 'EADDRINUSE') {
    console.error(`[ERROR] Port ${PORT} is already in use`);
    process.exit(1);
  }
});

// Periodic health log (reduce frequency)
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(`[HEALTH] Uptime=${Math.floor(process.uptime())}s, Memory=${Math.floor(memUsage.heapUsed / 1024 / 1024)}MB, Port=${PORT}`);
}, 60000);

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('[ERROR] Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

// Graceful shutdown
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`[SHUTDOWN] Received ${signal}, shutting down gracefully...`);
  
  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('[SHUTDOWN] Forced shutdown after timeout');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

// CRITICAL: Log that we've completed initialization
console.log('[STARTUP] Server initialization complete, starting HTTP listener...');
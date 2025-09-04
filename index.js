const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Railway port
const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0';

console.log(`Starting HubSpot API Bridge on ${HOST}:${PORT}...`);
console.log('Environment check:', {
  hasToken: !!process.env.PRIVATE_APP_ACCESS_TOKEN || !!process.env.HUBSPOT_ACCESS_TOKEN,
  port: PORT,
  node: process.version
});

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

// Create HTTP server with keep-alive
const server = http.createServer(async (req, res) => {
  // Set CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Connection', 'keep-alive');
  
  // Only log non-health check requests to reduce noise
  if (!req.url.includes('/health')) {
    console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  }
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }
  
  // Health check endpoints - respond immediately for Railway
  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz' || req.url === '/')) {
    // Respond immediately with minimal data for health checks
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ 
      status: 'healthy',
      timestamp: new Date().toISOString()
    }));
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
    try {
      const tools = await callMCPServer('tools/list');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(tools));
    } catch (error) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
    return;
  }
  
  // Call a tool
  if (req.method === 'POST' && req.url === '/api/call') {
    let body = '';
    
    req.on('data', chunk => {
      body += chunk.toString();
    });
    
    req.on('end', async () => {
      try {
        const request = JSON.parse(body);
        const result = await callMCPServer('tools/call', request);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
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

// Configure server with keep-alive
server.keepAliveTimeout = 120000; // 2 minutes
server.headersTimeout = 120000; // 2 minutes

// Start server
server.listen(PORT, HOST, () => {
  console.log(`✅ Web service listening on http://${HOST}:${PORT}`);
  console.log('✅ Health check available at /health');
  console.log('✅ API info available at /api');
  console.log(`✅ Process type: ${process.env.DYNO || 'web'}`);
  
  // Log initial status
  console.log('Server ready to handle requests');
  
  // Check HubSpot token
  const hasToken = process.env.PRIVATE_APP_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  if (!hasToken) {
    console.warn('⚠️  Warning: No HubSpot access token found (PRIVATE_APP_ACCESS_TOKEN or HUBSPOT_ACCESS_TOKEN)');
  } else {
    console.log('✅ HubSpot access token configured');
  }
});

// Periodic health log (every 60 seconds instead of 30)
setInterval(() => {
  const memUsage = process.memoryUsage();
  console.log(`Health: Uptime=${Math.floor(process.uptime())}s, Memory=${Math.floor(memUsage.heapUsed / 1024 / 1024)}MB, Connections=${server.connections || 0}`);
}, 60000);

// Error handlers
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Don't exit on uncaught exceptions
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  // Don't exit on unhandled rejections
});

// Graceful shutdown
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  
  console.log(`\nReceived ${signal}, shutting down gracefully...`);
  
  server.close(() => {
    console.log('HTTP server closed');
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('Could not close connections in time, forcefully shutting down');
    process.exit(1);
  }, 10000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

console.log('Server initialization complete');
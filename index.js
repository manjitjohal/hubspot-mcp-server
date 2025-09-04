const http = require('http');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);
const os = require('os');

// CRITICAL: Use Railway's assigned PORT (Railway shows 8080 in dashboard)
const PORT = parseInt(process.env.PORT) || 8080;
const HOST = '0.0.0.0';

// Railway might expect different binding
console.log(`[CONFIG] Will bind to ${HOST}:${PORT}`);
console.log(`[CONFIG] PORT from env: ${process.env.PORT}`);
console.log(`[CONFIG] Parsed PORT: ${PORT}`);

// Log ALL environment variables for debugging
console.log('[DEBUG] ALL ENVIRONMENT VARIABLES:');
Object.keys(process.env)
  .filter(key => key.startsWith('RAILWAY') || key === 'PORT' || key === 'HOST')
  .forEach(key => {
    console.log(`[DEBUG] ${key}=${process.env[key]}`);
  });

// Track startup time
const startTime = Date.now();
let requestCount = 0;
let healthCheckCount = 0;

// Log ALL environment variables at startup (redact sensitive ones)
console.log(`[STARTUP] === STARTING SERVER AT ${new Date().toISOString()} ===`);
console.log(`[STARTUP] Node version: ${process.version}`);
console.log(`[STARTUP] Platform: ${os.platform()}`);
console.log(`[STARTUP] Architecture: ${os.arch()}`);
console.log(`[STARTUP] Hostname: ${os.hostname()}`);
console.log(`[STARTUP] PID: ${process.pid}`);
console.log(`[STARTUP] PORT=${PORT}, HOST=${HOST}`);
console.log(`[STARTUP] Working directory: ${process.cwd()}`);

// Log important environment variables
console.log(`[ENV] NODE_ENV=${process.env.NODE_ENV || 'not set'}`);
console.log(`[ENV] RAILWAY_ENVIRONMENT=${process.env.RAILWAY_ENVIRONMENT || 'not set'}`);
console.log(`[ENV] RAILWAY_PROJECT_ID=${process.env.RAILWAY_PROJECT_ID || 'not set'}`);
console.log(`[ENV] RAILWAY_SERVICE_ID=${process.env.RAILWAY_SERVICE_ID || 'not set'}`);
console.log(`[ENV] RAILWAY_DEPLOYMENT_ID=${process.env.RAILWAY_DEPLOYMENT_ID || 'not set'}`);
console.log(`[ENV] DYNO=${process.env.DYNO || 'not set'}`);
console.log(`[ENV] HAS_HUBSPOT_TOKEN=${!!process.env.PRIVATE_APP_ACCESS_TOKEN || !!process.env.HUBSPOT_ACCESS_TOKEN}`);

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
    console.error('[ERROR] MCP server error:', error);
    throw error;
  }
}

// Track active connections
const activeConnections = new Set();

// Create HTTP server
const server = http.createServer((req, res) => {
  const requestId = ++requestCount;
  const requestStart = Date.now();
  const clientIp = req.socket.remoteAddress;
  
  // Track connection
  activeConnections.add(requestId);
  
  // Log EVERY request with details
  console.log(`[REQ-${requestId}] ${req.method} ${req.url} from ${clientIp} (active: ${activeConnections.size})`);
  console.log(`[REQ-${requestId}] Headers: ${JSON.stringify(req.headers)}`);
  
  // CRITICAL: Health check must respond IMMEDIATELY
  if (req.url === '/' || req.url === '/health' || req.url === '/healthz') {
    healthCheckCount++;
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('OK');
    
    const duration = Date.now() - requestStart;
    console.log(`[REQ-${requestId}] Health check #${healthCheckCount} completed in ${duration}ms`);
    
    // Log every 10th health check
    if (healthCheckCount % 10 === 0) {
      console.log(`[HEALTH] Total health checks: ${healthCheckCount}, uptime: ${Math.floor((Date.now() - startTime) / 1000)}s`);
    }
    
    activeConnections.delete(requestId);
    return;
  }
  
  // Set CORS headers for other requests
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    console.log(`[REQ-${requestId}] OPTIONS request completed`);
    activeConnections.delete(requestId);
    return;
  }
  
  // Detailed status endpoint
  if (req.method === 'GET' && req.url === '/status') {
    const status = {
      status: 'healthy',
      service: 'HubSpot MCP Server Bridge',
      version: '1.0.0',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      uptimeMs: Date.now() - startTime,
      memory: process.memoryUsage(),
      requests: {
        total: requestCount,
        healthChecks: healthCheckCount,
        active: activeConnections.size
      },
      hasToken: !!process.env.PRIVATE_APP_ACCESS_TOKEN || !!process.env.HUBSPOT_ACCESS_TOKEN,
      environment: {
        port: PORT,
        node: process.version,
        platform: os.platform(),
        railwayEnv: process.env.RAILWAY_ENVIRONMENT
      }
    };
    
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status, null, 2));
    
    console.log(`[REQ-${requestId}] Status request completed`);
    activeConnections.delete(requestId);
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
        status: 'GET /status',
        api: 'GET /api',
        tools: 'GET /api/tools',
        call: 'POST /api/call'
      },
      description: 'HTTP bridge for HubSpot MCP Server'
    }));
    console.log(`[REQ-${requestId}] API info request completed`);
    activeConnections.delete(requestId);
    return;
  }
  
  // List available tools
  if (req.method === 'GET' && req.url === '/api/tools') {
    callMCPServer('tools/list')
      .then(tools => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(tools));
        console.log(`[REQ-${requestId}] Tools list request completed`);
        activeConnections.delete(requestId);
      })
      .catch(error => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message }));
        console.error(`[REQ-${requestId}] Tools list request failed:`, error);
        activeConnections.delete(requestId);
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
      console.log(`[REQ-${requestId}] POST body received: ${body.length} bytes`);
      
      try {
        const request = JSON.parse(body);
        callMCPServer('tools/call', request)
          .then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
            console.log(`[REQ-${requestId}] Tool call completed successfully`);
            activeConnections.delete(requestId);
          })
          .catch(error => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: error.message }));
            console.error(`[REQ-${requestId}] Tool call failed:`, error);
            activeConnections.delete(requestId);
          });
      } catch (error) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ 
          error: error.message || 'Invalid request'
        }));
        console.error(`[REQ-${requestId}] Invalid JSON in request:`, error);
        activeConnections.delete(requestId);
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
  console.log(`[REQ-${requestId}] 404 - Unknown route: ${req.method} ${req.url}`);
  activeConnections.delete(requestId);
});

// Configure server
server.keepAliveTimeout = 120000;
server.headersTimeout = 120000;
server.timeout = 120000;

// Track server events
server.on('connection', (socket) => {
  console.log(`[CONNECTION] New connection from ${socket.remoteAddress}:${socket.remotePort}`);
  
  socket.on('close', () => {
    console.log(`[CONNECTION] Connection closed from ${socket.remoteAddress}:${socket.remotePort}`);
  });
  
  socket.on('error', (err) => {
    console.error(`[CONNECTION] Socket error from ${socket.remoteAddress}:`, err.message);
  });
});

// CRITICAL: Start server with callback to ensure Railway knows it's ready
server.listen(PORT, HOST, () => {
  const listenTime = Date.now() - startTime;
  const address = server.address();
  
  console.log(`[READY] ========================================`);
  console.log(`[READY] Server listening on http://${HOST}:${PORT}`);
  console.log(`[READY] Server address: ${JSON.stringify(address)}`);
  console.log(`[READY] Startup time: ${listenTime}ms`);
  console.log(`[READY] PID: ${process.pid}`);
  console.log(`[READY] Health check: http://${HOST}:${PORT}/health`);
  console.log(`[READY] Status page: http://${HOST}:${PORT}/status`);
  console.log(`[READY] Public URL: https://${process.env.RAILWAY_STATIC_URL || 'unknown'}`);
  
  // Test internal connectivity after server starts
  setTimeout(() => {
    const testUrl = `http://localhost:${PORT}/health`;
    console.log(`[READY] Testing internal connectivity to: ${testUrl}`);
    
    const http = require('http');
    const req = http.get(testUrl, (res) => {
      console.log(`[TEST] Internal health check: ${res.statusCode}`);
      res.on('data', (chunk) => {
        console.log(`[TEST] Response: ${chunk.toString()}`);
      });
    });
    
    req.on('error', (err) => {
      console.error(`[TEST] Internal connectivity failed:`, err.message);
    });
    
    req.setTimeout(5000, () => {
      console.error(`[TEST] Internal health check timeout`);
      req.destroy();
    });
  }, 1000);
  
  // Check HubSpot token
  const hasToken = process.env.PRIVATE_APP_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN;
  if (hasToken) {
    console.log('[READY] HubSpot access token: CONFIGURED');
  } else {
    console.log('[READY] HubSpot access token: NOT CONFIGURED');
  }
  
  // Multiple ready signals for Railway
  console.log('[READY] Server is ready to accept connections');
  console.log('[READY] Application started successfully');
  console.log('[READY] ========================================');
});

// Handle server errors
server.on('error', (err) => {
  console.error('[SERVER-ERROR] Server error:', err);
  console.error('[SERVER-ERROR] Error code:', err.code);
  console.error('[SERVER-ERROR] Error stack:', err.stack);
  
  if (err.code === 'EADDRINUSE') {
    console.error(`[SERVER-ERROR] Port ${PORT} is already in use`);
    process.exit(1);
  }
});

// Periodic detailed health log
setInterval(() => {
  const memUsage = process.memoryUsage();
  const uptime = Math.floor(process.uptime());
  
  console.log(`[HEARTBEAT] ====== ${new Date().toISOString()} ======`);
  console.log(`[HEARTBEAT] Uptime: ${uptime}s (${Math.floor(uptime/60)}m ${uptime%60}s)`);
  console.log(`[HEARTBEAT] Memory: RSS=${Math.floor(memUsage.rss / 1024 / 1024)}MB, Heap=${Math.floor(memUsage.heapUsed / 1024 / 1024)}MB`);
  console.log(`[HEARTBEAT] Requests: Total=${requestCount}, HealthChecks=${healthCheckCount}, Active=${activeConnections.size}`);
  console.log(`[HEARTBEAT] Port: ${PORT}, PID: ${process.pid}`);
  console.log(`[HEARTBEAT] ================================`);
}, 30000); // Every 30 seconds

// Error handlers with detailed logging
process.on('uncaughtException', (error) => {
  console.error('[UNCAUGHT-EXCEPTION] ================================');
  console.error('[UNCAUGHT-EXCEPTION] Error:', error.message);
  console.error('[UNCAUGHT-EXCEPTION] Stack:', error.stack);
  console.error('[UNCAUGHT-EXCEPTION] ================================');
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[UNHANDLED-REJECTION] ================================');
  console.error('[UNHANDLED-REJECTION] Promise:', promise);
  console.error('[UNHANDLED-REJECTION] Reason:', reason);
  console.error('[UNHANDLED-REJECTION] ================================');
});

// Graceful shutdown with detailed logging
let isShuttingDown = false;

function gracefulShutdown(signal) {
  if (isShuttingDown) {
    console.log(`[SHUTDOWN] Already shutting down, ignoring ${signal}`);
    return;
  }
  isShuttingDown = true;
  
  console.log(`[SHUTDOWN] ================================`);
  console.log(`[SHUTDOWN] Received ${signal} at ${new Date().toISOString()}`);
  console.log(`[SHUTDOWN] Total uptime: ${Math.floor(process.uptime())}s`);
  console.log(`[SHUTDOWN] Total requests served: ${requestCount}`);
  console.log(`[SHUTDOWN] Active connections: ${activeConnections.size}`);
  console.log(`[SHUTDOWN] Initiating graceful shutdown...`);
  
  server.close(() => {
    console.log('[SHUTDOWN] HTTP server closed successfully');
    console.log('[SHUTDOWN] Exiting with code 0');
    console.log(`[SHUTDOWN] ================================`);
    process.exit(0);
  });
  
  // Force shutdown after 10 seconds
  setTimeout(() => {
    console.error('[SHUTDOWN] Graceful shutdown timeout, forcing exit');
    console.error(`[SHUTDOWN] ================================`);
    process.exit(1);
  }, 10000);
}

// Listen for all possible termination signals
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

// Log exit events
process.on('exit', (code) => {
  console.log(`[EXIT] Process exiting with code ${code} at ${new Date().toISOString()}`);
});

// CRITICAL: Log that we've completed initialization
console.log('[STARTUP] Server initialization complete, starting HTTP listener...');
console.log('[STARTUP] Waiting for server.listen() callback...');
console.log('[STARTUP] BUILD: Force new deployment - commit 90bc20a');
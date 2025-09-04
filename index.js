const http = require('http');
const { spawn } = require('child_process');
const util = require('util');
const os = require('os');
const readline = require('readline');

// Use Railway's PORT environment variable (now configured to 3000)
const PORT = parseInt(process.env.PORT) || 3000;
const HOST = '0.0.0.0';

// Railway might expect different binding
console.log(`[CONFIG] Will bind to ${HOST}:${PORT}`);
console.log(`[CONFIG] PORT from env: ${process.env.PORT}`);
console.log(`[CONFIG] Parsed PORT: ${PORT}`);

// Log key environment variables
console.log('[INFO] Environment:');
console.log(`[INFO] RAILWAY_ENVIRONMENT=${process.env.RAILWAY_ENVIRONMENT || 'not set'}`);
console.log(`[INFO] RAILWAY_PUBLIC_DOMAIN=${process.env.RAILWAY_PUBLIC_DOMAIN || 'not set'}`);
console.log(`[INFO] HAS_HUBSPOT_TOKEN=${!!process.env.PRIVATE_APP_ACCESS_TOKEN || !!process.env.HUBSPOT_ACCESS_TOKEN}`);

// Track startup time
const startTime = Date.now();
let requestCount = 0;
let healthCheckCount = 0;

// Log startup information
console.log(`[STARTUP] Starting HubSpot MCP Bridge at ${new Date().toISOString()}`);
console.log(`[STARTUP] Node ${process.version}, PID ${process.pid}`);
console.log(`[STARTUP] Port: ${PORT}, Environment: ${process.env.RAILWAY_ENVIRONMENT || 'local'}`);

// MCP Server process and state
let mcpProcess = null;
let mcpReady = false;
let mcpInitialized = false;
const pendingRequests = new Map();
let requestIdCounter = 1;

// Simple in-memory cache for API responses
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Initialize HubSpot MCP Server
function initializeMCPServer() {
  if (mcpProcess) {
    console.log('[MCP] Server already running');
    return;
  }

  console.log('[MCP] Starting HubSpot MCP server...');
  
  // Set up environment for HubSpot MCP server
  const mcpEnv = {
    ...process.env,
    HUBSPOT_ACCESS_TOKEN: process.env.PRIVATE_APP_ACCESS_TOKEN || process.env.HUBSPOT_ACCESS_TOKEN
  };

  // Start the MCP server process
  mcpProcess = spawn('npx', ['@hubspot/mcp-server'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: mcpEnv
  });

  // Handle MCP server stdout
  const rl = readline.createInterface({
    input: mcpProcess.stdout,
    crlfDelay: Infinity
  });

  rl.on('line', (line) => {
    console.log(`[MCP-OUT] ${line}`);
    
    try {
      const response = JSON.parse(line);
      
      // Handle initialization response
      if (response.id === 'init' && response.result) {
        mcpReady = true;
        console.log('[MCP] Server initialized successfully');
        
        // Send initialized notification
        const initializedNotification = {
          jsonrpc: '2.0',
          method: 'notifications/initialized'
        };
        mcpProcess.stdin.write(JSON.stringify(initializedNotification) + '\n');
        mcpInitialized = true;
        console.log('[MCP] Initialization complete');
      }
      
      // Handle pending request responses
      if (response.id && pendingRequests.has(response.id)) {
        const { resolve, reject } = pendingRequests.get(response.id);
        pendingRequests.delete(response.id);
        
        if (response.error) {
          reject(new Error(response.error.message || 'MCP server error'));
        } else {
          resolve(response.result || response);
        }
      }
      
    } catch (error) {
      // Non-JSON output from MCP server
      if (line.includes('Server connected') || line.includes('ready')) {
        console.log('[MCP] Server appears ready');
      }
    }
  });

  // Handle MCP server stderr
  mcpProcess.stderr.on('data', (data) => {
    const output = data.toString();
    console.log(`[MCP-ERR] ${output}`);
    
    if (output.includes('Server connected')) {
      console.log('[MCP] Server connected via stderr');
    }
  });

  mcpProcess.on('error', (error) => {
    console.error('[MCP] Process error:', error);
    mcpReady = false;
    mcpInitialized = false;
  });

  mcpProcess.on('exit', (code) => {
    console.log(`[MCP] Process exited with code ${code}`);
    mcpReady = false;
    mcpInitialized = false;
    mcpProcess = null;
    
    // Clear pending requests
    pendingRequests.forEach(({ reject }) => {
      reject(new Error('MCP server process exited'));
    });
    pendingRequests.clear();
  });

  // Send initialization request after a short delay
  setTimeout(() => {
    if (mcpProcess && !mcpReady) {
      console.log('[MCP] Sending initialization request...');
      const initRequest = {
        jsonrpc: '2.0',
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: {
            name: 'hubspot-mcp-bridge',
            version: '1.0.0'
          }
        },
        id: 'init'
      };
      mcpProcess.stdin.write(JSON.stringify(initRequest) + '\n');
    }
  }, 1000);
}

// Helper to call HubSpot MCP server
async function callMCPServer(method, params = {}) {
  const cacheKey = `${method}:${JSON.stringify(params)}`;
  
  // Check cache first
  const cached = cache.get(cacheKey);
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    console.log(`[MCP] Cache hit for ${method}`);
    return cached.data;
  }

  // Ensure MCP server is initialized
  if (!mcpProcess || !mcpInitialized) {
    console.log('[MCP] Server not ready, initializing...');
    initializeMCPServer();
    
    // Wait for initialization
    let attempts = 0;
    while ((!mcpReady || !mcpInitialized) && attempts < 20) {
      await new Promise(resolve => setTimeout(resolve, 500));
      attempts++;
    }
    
    if (!mcpReady || !mcpInitialized) {
      throw new Error('MCP server failed to initialize');
    }
  }

  return new Promise((resolve, reject) => {
    const requestId = requestIdCounter++;
    const request = {
      jsonrpc: '2.0',
      method: method,
      params: params,
      id: requestId
    };

    console.log(`[MCP] Sending request: ${method} (id: ${requestId})`);
    
    // Store the request handlers
    pendingRequests.set(requestId, { resolve, reject });
    
    // Set timeout for request
    const timeout = setTimeout(() => {
      if (pendingRequests.has(requestId)) {
        pendingRequests.delete(requestId);
        reject(new Error('MCP request timeout'));
      }
    }, 10000); // 10 second timeout

    // Override resolve/reject to clear timeout
    const originalResolve = resolve;
    const originalReject = reject;
    
    pendingRequests.set(requestId, {
      resolve: (result) => {
        clearTimeout(timeout);
        
        // Cache successful responses
        if (result) {
          cache.set(cacheKey, {
            data: result,
            timestamp: Date.now()
          });
        }
        
        originalResolve(result);
      },
      reject: (error) => {
        clearTimeout(timeout);
        originalReject(error);
      }
    });

    // Send request to MCP server
    try {
      mcpProcess.stdin.write(JSON.stringify(request) + '\n');
    } catch (error) {
      clearTimeout(timeout);
      pendingRequests.delete(requestId);
      reject(new Error(`Failed to send MCP request: ${error.message}`));
    }
  });
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
  
  // Log requests (except health checks to reduce noise)
  if (!req.url.includes('/health')) {
    console.log(`[REQ-${requestId}] ${req.method} ${req.url} from ${clientIp}`);
  }
  
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
  
  // Initialize MCP server after HTTP server is ready
  setTimeout(() => {
    console.log('[READY] Initializing HubSpot MCP server...');
    initializeMCPServer();
  }, 2000);
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

// Periodic health log (reduced frequency since service is stable)
setInterval(() => {
  const memUsage = process.memoryUsage();
  const uptime = Math.floor(process.uptime());
  
  console.log(`[HEARTBEAT] Uptime: ${uptime}s, Memory: ${Math.floor(memUsage.heapUsed / 1024 / 1024)}MB, Requests: ${requestCount}, MCP: ${mcpReady ? 'Ready' : 'Not Ready'}`);
}, 60000); // Every 60 seconds

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
  
  // Clean up MCP server process
  if (mcpProcess) {
    console.log('[SHUTDOWN] Terminating MCP server...');
    mcpProcess.kill('SIGTERM');
    mcpProcess = null;
  }
  
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
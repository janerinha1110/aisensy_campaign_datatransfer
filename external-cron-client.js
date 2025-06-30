const axios = require('axios');
const express = require('express');
require('dotenv').config();

// Configuration
const INTERNAL_SERVER_URL = process.env.INTERNAL_SERVER_URL || 'http://localhost:3001';
const EXTERNAL_API_PORT = process.env.EXTERNAL_API_PORT || 3002;
const CRON_SECRET = process.env.CRON_SECRET;

// Create external API server
const app = express();

// Configure middleware
app.use(express.json());

// Add CORS for external access
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(200);
  } else {
    next();
  }
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'External Cron Client API'
  });
});

// External endpoint to trigger cron check
app.post('/trigger-cron', async (req, res) => {
  console.log('External cron trigger requested at:', new Date().toISOString());
  
  try {
    // Optional authentication for external calls
    const authHeader = req.headers.authorization;
    const expectedToken = process.env.EXTERNAL_API_TOKEN;
    
    if (expectedToken && authHeader !== `Bearer ${expectedToken}`) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or missing token'
      });
    }

    // Prepare headers for internal call
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // Add cron secret if configured
    if (CRON_SECRET) {
      headers['x-vercel-cron-secret'] = CRON_SECRET;
    }

    console.log(`Calling internal cron endpoint: ${INTERNAL_SERVER_URL}/api/cron-check`);
    
    // Call the internal cron-check endpoint
    const response = await axios.get(`${INTERNAL_SERVER_URL}/api/cron-check`, {
      headers: headers,
      timeout: 300000 // 5 minutes timeout for long-running operations
    });

    console.log('Internal cron call successful');
    
    res.json({
      success: true,
      message: 'Cron job triggered successfully',
      data: response.data,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error triggering cron job:', error.message);
    
    if (error.response) {
      // The internal server responded with an error
      res.status(error.response.status).json({
        success: false,
        error: 'Internal server error',
        details: error.response.data,
        timestamp: new Date().toISOString()
      });
    } else if (error.code === 'ECONNREFUSED') {
      // Internal server is not running
      res.status(503).json({
        success: false,
        error: 'Internal server is not available',
        details: 'Make sure the main application is running',
        timestamp: new Date().toISOString()
      });
    } else {
      // Other errors
      res.status(500).json({
        success: false,
        error: 'Failed to trigger cron job',
        details: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

// GET endpoint for easy browser/curl access
app.get('/trigger-cron', async (req, res) => {
  console.log('External cron trigger requested via GET at:', new Date().toISOString());
  
  try {
    // Check for token in query params for GET requests
    const token = req.query.token;
    const expectedToken = process.env.EXTERNAL_API_TOKEN;
    
    if (expectedToken && token !== expectedToken) {
      return res.status(401).json({
        success: false,
        error: 'Unauthorized: Invalid or missing token parameter'
      });
    }

    // Prepare headers for internal call
    const headers = {
      'Content-Type': 'application/json'
    };
    
    if (CRON_SECRET) {
      headers['x-vercel-cron-secret'] = CRON_SECRET;
    }

    console.log(`Calling internal cron endpoint: ${INTERNAL_SERVER_URL}/api/cron-check`);
    
    const response = await axios.get(`${INTERNAL_SERVER_URL}/api/cron-check`, {
      headers: headers,
      timeout: 300000
    });

    console.log('Internal cron call successful');
    
    res.json({
      success: true,
      message: 'Cron job triggered successfully',
      data: response.data,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error triggering cron job:', error.message);
    
    if (error.response) {
      res.status(error.response.status).json({
        success: false,
        error: 'Internal server error',
        details: error.response.data,
        timestamp: new Date().toISOString()
      });
    } else if (error.code === 'ECONNREFUSED') {
      res.status(503).json({
        success: false,
        error: 'Internal server is not available',
        details: 'Make sure the main application is running on ' + INTERNAL_SERVER_URL,
        timestamp: new Date().toISOString()
      });
    } else {
      res.status(500).json({
        success: false,
        error: 'Failed to trigger cron job',
        details: error.message,
        timestamp: new Date().toISOString()
      });
    }
  }
});

// Status endpoint to check internal server
app.get('/status', async (req, res) => {
  try {
    const response = await axios.get(`${INTERNAL_SERVER_URL}/campaigns`, {
      timeout: 10000
    });
    
    res.json({
      externalApi: 'running',
      internalServer: 'reachable',
      internalServerUrl: INTERNAL_SERVER_URL,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.json({
      externalApi: 'running',
      internalServer: 'unreachable',
      internalServerUrl: INTERNAL_SERVER_URL,
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// API documentation endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'External Cron Client API',
    version: '1.0.0',
    endpoints: {
      'GET /': 'This documentation',
      'GET /health': 'Health check',
      'GET /status': 'Check internal server status',
      'POST /trigger-cron': 'Trigger cron job (with Authorization header)',
      'GET /trigger-cron?token=TOKEN': 'Trigger cron job (with token parameter)'
    },
    usage: {
      'POST': 'curl -X POST http://localhost:' + EXTERNAL_API_PORT + '/trigger-cron -H "Authorization: Bearer YOUR_TOKEN"',
      'GET': 'curl "http://localhost:' + EXTERNAL_API_PORT + '/trigger-cron?token=YOUR_TOKEN"'
    },
    environment: {
      INTERNAL_SERVER_URL: INTERNAL_SERVER_URL,
      EXTERNAL_API_PORT: EXTERNAL_API_PORT,
      CRON_SECRET: CRON_SECRET ? 'configured' : 'not configured',
      EXTERNAL_API_TOKEN: process.env.EXTERNAL_API_TOKEN ? 'configured' : 'not configured'
    },
    timestamp: new Date().toISOString()
  });
});

// Start the external API server
app.listen(EXTERNAL_API_PORT, () => {
  console.log(`External Cron Client API is running on port ${EXTERNAL_API_PORT}`);
  console.log(`Internal server URL: ${INTERNAL_SERVER_URL}`);
  console.log('Available endpoints:');
  console.log(`  - GET  http://localhost:${EXTERNAL_API_PORT}/ (Documentation)`);
  console.log(`  - GET  http://localhost:${EXTERNAL_API_PORT}/health`);
  console.log(`  - GET  http://localhost:${EXTERNAL_API_PORT}/status`);
  console.log(`  - POST http://localhost:${EXTERNAL_API_PORT}/trigger-cron`);
  console.log(`  - GET  http://localhost:${EXTERNAL_API_PORT}/trigger-cron?token=TOKEN`);
  console.log('');
  console.log('To trigger cron job:');
  console.log(`  curl -X POST http://localhost:${EXTERNAL_API_PORT}/trigger-cron`);
  console.log(`  curl "http://localhost:${EXTERNAL_API_PORT}/trigger-cron?token=YOUR_TOKEN"`);
  console.log('');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully');
  process.exit(0);
}); 
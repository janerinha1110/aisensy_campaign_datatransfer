#!/usr/bin/env node

const axios = require('axios');
require('dotenv').config();

// Configuration
const INTERNAL_SERVER_URL = process.env.INTERNAL_SERVER_URL || 'http://localhost:3001';
const CRON_SECRET = process.env.CRON_SECRET;

async function triggerCron() {
  console.log('🚀 Triggering cron job...');
  console.log(`📡 Server URL: ${INTERNAL_SERVER_URL}`);
  console.log(`⏰ Time: ${new Date().toISOString()}`);
  console.log('');

  try {
    // Prepare headers
    const headers = {
      'Content-Type': 'application/json'
    };
    
    // Add cron secret if configured
    if (CRON_SECRET) {
      headers['x-vercel-cron-secret'] = CRON_SECRET;
      console.log('🔐 Using cron secret for authentication');
    } else {
      console.log('⚠️  No cron secret configured');
    }

    console.log('📞 Calling cron endpoint...');
    
    // Call the cron-check endpoint
    const response = await axios.get(`${INTERNAL_SERVER_URL}/api/cron-check`, {
      headers: headers,
      timeout: 300000 // 5 minutes timeout
    });

    console.log('✅ Cron job triggered successfully!');
    console.log('');
    console.log('📊 Response:');
    console.log(JSON.stringify(response.data, null, 2));

  } catch (error) {
    console.error('❌ Error triggering cron job:');
    
    if (error.response) {
      console.error(`Status: ${error.response.status}`);
      console.error('Response:', JSON.stringify(error.response.data, null, 2));
    } else if (error.code === 'ECONNREFUSED') {
      console.error('🔌 Connection refused - make sure your main application is running');
      console.error(`Expected URL: ${INTERNAL_SERVER_URL}`);
    } else {
      console.error(error.message);
    }
    
    process.exit(1);
  }
}

// Check if this script is being run directly
if (require.main === module) {
  triggerCron();
}

module.exports = { triggerCron }; 
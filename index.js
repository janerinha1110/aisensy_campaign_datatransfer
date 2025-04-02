require('dotenv').config();
const { chromium } = require('playwright');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const sendCsvToSlack = require('./send-to-slack');

const STORAGE_STATE_PATH = path.join(__dirname, 'auth.json');
const SESSION_EXPIRY_PATH = path.join(__dirname, 'session-expiry.json');
const SLACK_CAMPAIGN_WEBHOOK_URL = 'YOUR_SLACK_WEBHOOK_URL_HERE'; // TODO: Replace with actual webhook URL
const RATE_LIMIT_LOG_PATH = path.join(__dirname, 'rate-limit-log.txt');
const FILTERED_CAMPAIGNS_PATH = path.join(__dirname, 'filtered-campaigns.json');
const CAMPAIGN_DETAILS_OUTPUT_PATH = path.join(__dirname, 'campaign-details-output.json');
const CAMPAIGN_DETAILS_CSV_PATH = path.join(__dirname, 'campaign-details.csv');

// Create Express server
const app = express();
const PORT = process.env.PORT || 3000;

// Configure middleware
app.use(express.json());

// Campaigns API endpoint
app.get('/campaigns', async (req, res) => {
  console.log('Campaigns API endpoint called');
  
  try {
    // Check if we need to login first
    if (!isSessionValid()) {
      console.log('No valid session, performing login first');
      // We need to login first, then scrape campaign details
      const loginPromise = login();
      
      // Set a timeout to prevent hanging
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Login and campaign scraping timed out')), 60000);
      });
      
      // Wait for login to complete or timeout
      await Promise.race([loginPromise, timeoutPromise]);
      
      // Fetch campaign details after login
      const campaignDetails = await scrapeCampaignDetails();
      
      if (campaignDetails) {
        return res.json({ 
          success: true, 
          campaigns: campaignDetails,
          timestamp: new Date().toISOString()
        });
      } else {
        return res.status(500).json({ 
          success: false, 
          error: 'Could not retrieve campaign details after login' 
        });
      }
    } else {
      // Session is valid, just scrape campaign details
      const campaignDetails = await scrapeCampaignDetails();
      
      if (campaignDetails) {
        return res.json({ 
          success: true, 
          campaigns: campaignDetails,
          timestamp: new Date().toISOString() 
        });
      } else {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to retrieve campaign details' 
        });
      }
    }
  } catch (error) {
    console.error('Error in campaigns endpoint:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Campaigns API available at http://localhost:${PORT}/campaigns`);
});

async function login() {
  console.log('Starting login process...');
  const browser = await chromium.launch({ 
    headless: false, 
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process'
    ]
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    // Navigate to login page
    await page.goto(process.env.LOGIN_URL, { waitUntil: 'networkidle' });
    console.log('Navigated to login page');

    // Fill login form
    await page.fill('input[type="email"]', process.env.EMAIL);
    await page.fill('input[type="password"]', process.env.PASSWORD);
    
    // Try multiple selectors to find the login button
    const buttonSelectors = [
      // Try to select the second Continue button specifically
      ':nth-match(button:has-text("Continue"), 2)',
      'button.MuiButton-contained:has-text("Continue")', 
      'button.MuiButton-root:has-text("Continue")',
      'button[type="submit"]',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      '.login-button',
      'form button',
      'button.MuiButton-contained',
      'button.MuiButton-root'
    ];
    
    // Try each selector until we find a visible button
    let buttonFound = false;
    for (const selector of buttonSelectors) {
      const button = await page.$(selector);
      if (button && await button.isVisible()) {
        console.log(`Found login button with selector: ${selector}`);
        // Click button and wait for navigation
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle' }),
          button.click()
        ]);
        buttonFound = true;
        break;
      }
    }
    
    if (!buttonFound) {
      // Try to get all Continue buttons and click the second one
      console.log('Trying to click second Continue button...');
      const continueButtons = await page.$$('button:has-text("Continue")');
      if (continueButtons.length >= 2) {
        console.log('Found multiple Continue buttons, clicking the second one');
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle' }),
          continueButtons[1].click()
        ]);
      } else {
        // As a fallback, try clicking the last button in the form
        console.log('Trying to click the last button in the form...');
        const formButtons = await page.$$('form button');
        if (formButtons.length > 0) {
          const lastButton = formButtons[formButtons.length - 1];
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle' }),
            lastButton.click()
          ]);
        } else {
          // If that fails, try taking a screenshot to debug
          await page.screenshot({ path: 'login-debug.png' });
          throw new Error('Could not find the login button with any selector');
        }
      }
    }
    
    console.log('Login successful');

    // Store authentication state
    await context.storageState({ path: STORAGE_STATE_PATH });
    
    // Save session expiry time (24 hours from now)
    const expiryTime = new Date();
    expiryTime.setHours(expiryTime.getHours() + 24);
    fs.writeFileSync(
      SESSION_EXPIRY_PATH,
      JSON.stringify({ expiry: expiryTime.toISOString() })
    );
    
    console.log('Session saved, will expire at:', expiryTime);
    
    // After login, immediately scrape campaign information
    await scrapeCampaignDetails(context);

  } catch (error) {
    console.error('Login failed:', error);
  } finally {
    await browser.close();
  }
}

async function scrapeCampaignDetails() {
  console.log('Starting campaign details scraping process...');
  // Browser instance is not created here anymore

  // --- Clear previous output/log files --- 
  try {
    fs.writeFileSync(RATE_LIMIT_LOG_PATH, ''); // Clear rate limit log
    fs.writeFileSync(FILTERED_CAMPAIGNS_PATH, ''); // Clear filtered campaigns
    fs.writeFileSync(CAMPAIGN_DETAILS_OUTPUT_PATH, ''); // Clear campaign details output
    console.log('Cleared previous log and output files.');
  } catch (clearError) {
    console.error(`Error clearing files: ${clearError}`);
    // Log this specific error to console, as the log file itself might be the issue
  }
  // --- End file clearing ---

  try {
    // Session validity is checked by the caller (API endpoint/startup) before calling this.
    // If we reach here, we assume a valid session *should* exist.
    
    // Extract cookies and token from stored session
    const storageState = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
    const cookies = storageState.cookies || [];
    
    // Find token cookie
    let token = '';
    for (const cookie of cookies) {
      if (cookie.name === 'token') {
        token = cookie.value;
        break;
      }
    }
    
    if (!token) {
      console.error('Token not found in session cookies');
      return null;
    }
    
    console.log('Found authentication token, fetching campaigns...');
    
    const allCampaigns = [];
    let skip = 0;
    const rowsPerPage = 100; // Max allowed by API
    let totalCampaigns = Infinity; // Initialize to loop at least once
    
    try {
      // Fetch all campaigns with pagination
      while (allCampaigns.length < totalCampaigns) {
        console.log(`Fetching campaigns: skip=${skip}, rowsPerPage=${rowsPerPage}`);
        const campaignsResponse = await axiosWithRetry({
        method: 'post',
          url: 'https://backend.aisensy.com/client/t1/api/campaigns',
        headers: {
          'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json;charset=UTF-8',
          'Origin': 'https://www.app.aisensy.com',
          'Referer': 'https://www.app.aisensy.com/'
        },
        data: {
            assistantId: process.env.ASSISTANT_ID || "6515621dfe38c80b4d35a1a7",
            skip: skip,
            rowsPerPage: rowsPerPage,
            nameQuery: "",
            tabType: "all" // Fetch all types initially
          },
          timeout: 30000 // Add timeout for campaign list request
        });
        
        const campaignsData = campaignsResponse.data;
        
        if (!campaignsData || !campaignsData.campaigns) {
            console.error('Invalid campaign data received:', campaignsData);
            throw new Error('Failed to fetch campaigns: Invalid data format');
        }
        
        allCampaigns.push(...campaignsData.campaigns);
        totalCampaigns = campaignsData.totalCampaigns || 0; // Update total count
        
        // Check if there's a next page using newSkip or total count
        if (campaignsData.newSkip > skip && allCampaigns.length < totalCampaigns) {
            skip = campaignsData.newSkip;
      } else {
            break; // Exit loop if no more pages or newSkip didn't advance
        }
      }
      
      console.log(`Fetched total ${allCampaigns.length} campaigns.`);
      
      // Filter campaigns
      const filterStartDate = new Date('2025-01-01T00:00:00.000Z'); // Campaign creation date filter
      const relevantCampaigns = allCampaigns.filter(campaign => {
          const createdAtDate = new Date(campaign.createdAt);
          return campaign.type === 'API' && 
                 campaign.status === 'LIVE' &&
                 createdAtDate >= filterStartDate;
      });
      
      console.log(`Found ${relevantCampaigns.length} relevant API/LIVE campaigns created on or after ${filterStartDate.toISOString().split('T')[0]}.`);
      
      // --- Save filtered campaigns to a file ---
      try {
        fs.writeFileSync(FILTERED_CAMPAIGNS_PATH, JSON.stringify(relevantCampaigns, null, 2));
        console.log(`Saved ${relevantCampaigns.length} filtered campaigns to ${FILTERED_CAMPAIGNS_PATH}`);
      } catch (writeError) {
        console.error(`Error writing filtered campaigns file: ${writeError}`);
        logRateLimit(`Error writing filtered campaigns file: ${writeError.message}`);
      }
      // --- End save filtered campaigns ---

      if (relevantCampaigns.length === 0) {
          console.log('No relevant campaigns found.');
          return []; // Return empty array if no relevant campaigns
      }

      // Fetch details for each relevant campaign
      const campaignDetails = [];
      const assistantId = process.env.ASSISTANT_ID || "6515621dfe38c80b4d35a1a7";
      
      // Define date range (e.g., last 1 day up to today)
      const toDate = new Date(); // End date is now
      const fromDate = new Date();
      fromDate.setDate(toDate.getDate() - 1); // Start date is 1 day ago

      console.log(`Fetching details for campaigns from ${fromDate.toISOString()} to ${toDate.toISOString()}`);

      // Process campaigns sequentially with delay to avoid rate limits
      const delayBetweenRequests = 1000; // Delay in milliseconds (e.g., 1 second)

      // Initialize the output file with an opening bracket for a JSON array
      fs.writeFileSync(CAMPAIGN_DETAILS_OUTPUT_PATH, '[\n');
      let detailCount = 0;

      // Iterate directly over relevant campaigns sequentially
      for (const campaign of relevantCampaigns) {
          console.log(`Fetching details for campaign: ${campaign.name} (ID: ${campaign._id})`);
          let detailResult = null;
          let success = false;
          try {
              // Use the retry helper for the campaign details API call
              const detailsResponse = await axiosWithRetry({ // Await each call
                  method: 'post',
                  url: 'https://backend.aisensy.com/client/t1/api/campaign-chats',
                  headers: {
                      'Authorization': `Bearer ${token}`,
                      'Content-Type': 'application/json;charset=UTF-8',
                      'Origin': 'https://www.app.aisensy.com',
                      'Referer': 'https://www.app.aisensy.com/'
                  },
                  data: {
                      assistantId: assistantId,
                      campaignId: campaign._id,
                      fromDate: fromDate.toISOString(),
                      toDate: toDate.toISOString()
                  },
                  timeout: 30000 // Add timeout for campaign details request
              });

              const detailsData = detailsResponse.data;
              
              if (detailsData && detailsData.chats && detailsData.chats.length > 0) {
                  // Extract required fields from the first chat object
                  const firstChat = detailsData.chats[0];
                  detailResult = {
                      campaignName: campaign.name,
                      campaignId: campaign._id,
                      sent: firstChat.sentChatCount ?? 0, // Use nullish coalescing for safety
                      delivered: firstChat.deliveredChatcount ?? 0,
                      read: firstChat.readChatCount ?? 0,
                      failed: firstChat.failedChatCount ?? 0,
                      timestamp: new Date().toISOString() // Add timestamp for this specific detail fetch
                  };
                  console.log(`Successfully fetched details for campaign: ${campaign.name}`);
                  success = true;
              } else {
                  console.warn(`No chat details found for campaign: ${campaign.name} (ID: ${campaign._id})`);
                   detailResult = { // Add entry even if no chats found, indicating 0 counts
                      campaignName: campaign.name,
                      campaignId: campaign._id,
                      sent: 0,
                      delivered: 0,
                      read: 0,
                      failed: 0,
                      timestamp: new Date().toISOString(),
                      note: "No chat data found in API response for the specified date range."
                  };
              }

              // Add the result to the main list (for returning)
              campaignDetails.push(detailResult);
              
              // Write this detail to the output file immediately
              try {
                  const separator = detailCount > 0 ? ',\n' : ''; // Add comma if not the first item
                  fs.appendFileSync(CAMPAIGN_DETAILS_OUTPUT_PATH, 
                      `${separator}${JSON.stringify(detailResult, null, 2)}`);
                  detailCount++;
                  console.log(`Wrote details for campaign: ${campaign.name} to output file`);
              } catch (writeError) {
                  console.error(`Error writing detail for campaign ${campaign.name} to file: ${writeError.message}`);
                  logRateLimit(`Error writing detail for campaign ${campaign.name} to file: ${writeError.message}`);
              }

              // --- Add delay after successful processing of one campaign --- 
              console.log(`Waiting ${delayBetweenRequests}ms before next request...`);
              await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));

          } catch (detailError) {
              console.error(`Critical error processing campaign ${campaign.name} (ID: ${campaign._id}), skipping delay:`, detailError.message);
              // Construct error object even if the awaited call fails catastrophically
               detailResult = {
                   campaignName: campaign.name,
                   campaignId: campaign._id,
                   error: `Failed to process details: ${detailError.message}`,
                   timestamp: new Date().toISOString()
               };
               campaignDetails.push(detailResult);
              
               // Write the error detail to file immediately
               try {
                   const separator = detailCount > 0 ? ',\n' : ''; // Add comma if not the first item
                   fs.appendFileSync(CAMPAIGN_DETAILS_OUTPUT_PATH, 
                       `${separator}${JSON.stringify(detailResult, null, 2)}`);
                   detailCount++;
                   console.log(`Wrote error details for campaign: ${campaign.name} to output file`);
               } catch (writeError) {
                   console.error(`Error writing error detail for campaign ${campaign.name} to file: ${writeError.message}`);
                   logRateLimit(`Error writing error detail for campaign ${campaign.name} to file: ${writeError.message}`);
               }
               
               // Decide if we should continue or stop on critical errors
               // For now, log and continue with the next campaign
               logRateLimit(`CRITICAL error processing campaign ${campaign.name}. Error: ${detailError.message}`);
              // Skip the delay if there was a critical error processing this campaign
          }

          if (success) {
              // No delay if there was a successful processing for this campaign
              console.log(`No delay due to successful processing campaign: ${campaign.name}`);
          } else {
              // No delay if there was an error for this campaign
              console.log(`Skipping delay due to error processing campaign: ${campaign.name}`);
          }
      } // End loop over relevantCampaigns

      // Close the JSON array in the output file
      try {
          fs.appendFileSync(CAMPAIGN_DETAILS_OUTPUT_PATH, '\n]');
          console.log(`Completed writing ${detailCount} campaign details to ${CAMPAIGN_DETAILS_OUTPUT_PATH}`);
          logRateLimit(`Completed writing ${detailCount} campaign details to ${CAMPAIGN_DETAILS_OUTPUT_PATH}`);
      } catch (writeError) {
          console.error(`Error finalizing campaign details output file: ${writeError.message}`);
          logRateLimit(`Error finalizing campaign details output file: ${writeError.message}`);
      }

      console.log('Campaign details processed.');

      // Send aggregated details to Slack (using placeholder function)
      await sendCampaignDetailsToSlack(campaignDetails);
      
      return campaignDetails; // Return the aggregated details

    } catch (apiError) {
      console.error('Campaign API request failed:', apiError.message);
      if (apiError.response) {
        console.error('Response status:', apiError.response.status);
        console.error('Response data:', apiError.response.data);
        
        // Handle 401 unauthorized error (session expired)
        if (apiError.response.status === 401) {
          console.log('Session expired (401 error). Initiating new login...');
          
          // Delete the current session files
          try {
            if (fs.existsSync(STORAGE_STATE_PATH)) {
              fs.unlinkSync(STORAGE_STATE_PATH);
              console.log('Removed expired auth.json file');
            }
            if (fs.existsSync(SESSION_EXPIRY_PATH)) {
              fs.unlinkSync(SESSION_EXPIRY_PATH);
              console.log('Removed expired session-expiry.json file');
            }
          } catch (fsError) {
            console.error('Error removing session files:', fsError);
          }
          
          // We should probably just throw the error here and let the endpoint handle re-login
          throw new Error('Session expired during campaign fetch'); 
        }
      }
      
      throw apiError; // Rethrow the error for the caller to handle
    }
  } catch (error) {
    console.error('Error during campaign detail scraping:', error);
    throw error; // Rethrow the error
  }
}

function isSessionValid() {
  try {
    // Check if auth.json exists
    if (!fs.existsSync(STORAGE_STATE_PATH)) {
      return false;
    }
    
    // Check if session-expiry.json exists and session is still valid
    if (fs.existsSync(SESSION_EXPIRY_PATH)) {
      const { expiry } = JSON.parse(fs.readFileSync(SESSION_EXPIRY_PATH, 'utf8'));
      const expiryDate = new Date(expiry);
      const now = new Date();
      return expiryDate > now;
    }
    
    return false;
  } catch (error) {
    console.error('Error checking session validity:', error);
    return false;
  }
}

// Add process error handlers to prevent crashes
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled rejection at:', promise, 'reason:', reason);
});

// Schedule to run every day at 12:00 AM IST (6:30 PM UTC)
console.log('Starting cron job for campaign detail checks at 12:00 AM IST daily...');
cron.schedule('30 18 * * *', async () => {
  try {
    console.log('Running scheduled campaign detail check...');
    await scrapeCampaignDetails().catch(err => {
      console.error('Error in scheduled campaign detail check:', err);
    });
  } catch (error) {
    console.error('Cron job error:', error);
  }
});

// Initial run on startup
console.log('Server started, initializing first campaign detail check...');
(async () => {
  try {
    if (isSessionValid()) {
      console.log('Using existing session for initial check');
      await scrapeCampaignDetails().catch(err => {
        console.error('Error in initial campaign detail check:', err);
      });
    } else {
      console.log('No valid session found, logging in...');
      await login().catch(err => {
        console.error('Error during initial login:', err);
      });
    }
  } catch (error) {
    console.error('Error during startup sequence:', error);
  }
})();

// Endpoint for Vercel cron job integration
app.get('/api/cron-check', async (req, res) => {
  // Optional: verify a secret to ensure only authorized cron jobs can trigger this
  const secretHeader = req.headers['x-vercel-cron-secret'];
  
  if (process.env.CRON_SECRET && secretHeader !== process.env.CRON_SECRET) {
    return res.status(401).json({ 
      success: false, 
      error: 'Unauthorized cron request' 
    });
  }
  
  console.log('Running cron job via API endpoint...');
  try {
    const campaignDetails = await scrapeCampaignDetails();
    
    if (campaignDetails) {
      return res.json({ 
        success: true, 
        campaigns: campaignDetails,
        timestamp: new Date().toISOString()
      });
    } else {
      return res.status(500).json({ 
        success: false, 
        error: 'Failed to retrieve campaign details' 
      });
    }
  } catch (error) {
    console.error('Error in cron endpoint:', error);
    return res.status(500).json({ 
      success: false, 
      error: 'Internal server error' 
    });
  }
});

// Initial run on startup - only in non-Vercel environments
// In Vercel, endpoints are only activated when called
if (process.env.VERCEL_ENV === undefined) {
  console.log('Server started, waiting for API requests at /campaigns');
} else {
  console.log('Server running in Vercel environment, endpoints ready');
}

// Placeholder function to send campaign details to Slack
async function sendCampaignDetailsToSlack(campaignDetails) {
  console.log("Sending campaign details to Slack...");
  
  try {
    // First, convert the campaignDetails to CSV format
    const csvData = convertToCsv(campaignDetails);
    
    // Save the CSV file locally (temporary)
    fs.writeFileSync(CAMPAIGN_DETAILS_CSV_PATH, csvData);
    console.log(`CSV file created at ${CAMPAIGN_DETAILS_CSV_PATH}`);
    
    // Send CSV directly to Slack
    await sendCsvToSlack();
    
  } catch (error) {
    console.error('Error sending campaign details to Slack:', error.message);
    logRateLimit(`Error sending campaign details to Slack: ${error.message}`);
  }
}

// Function to convert JSON data to CSV format
function convertToCsv(jsonData) {
  if (!jsonData || jsonData.length === 0) {
    return 'No data available';
  }
  
  // Extract headers from the first object
  const headers = Object.keys(jsonData[0])
    .filter(key => key !== 'note') // Optionally exclude certain fields
    .join(',');
  
  // Create CSV rows from each object
  const rows = jsonData.map(item => {
    return Object.keys(jsonData[0])
      .filter(key => key !== 'note') // Match the same fields as in headers
      .map(key => {
        // Handle values that need escaping or formatting
        let value = item[key] === undefined || item[key] === null ? '' : item[key];
        
        // Escape quotes and wrap strings with commas in quotes
        if (typeof value === 'string') {
          if (value.includes(',') || value.includes('"') || value.includes('\n')) {
            value = `"${value.replace(/"/g, '""')}"`;
          }
        }
        
        return value;
      })
      .join(',');
  });
  
  // Combine headers and rows
  return `${headers}\n${rows.join('\n')}`;
}

// Helper function for logging rate limits
function logRateLimit(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp}: ${message}\n`;
  try {
    // Ensure the directory exists (though __dirname should always exist)
    fs.appendFileSync(RATE_LIMIT_LOG_PATH, logMessage);
  } catch (err) {
    console.error("Failed to write to rate limit log:", err);
  }
}

// Helper function for making Axios requests with retry logic for rate limiting (429)
async function axiosWithRetry(axiosConfig, maxRetries = 3, initialDelay = 2000) { // Increased initial delay
  let retries = 0;

  while (retries <= maxRetries) {
    try {
      // Add a small random jitter to the delay to prevent thundering herd
      const jitter = Math.random() * 500; // 0-500ms jitter
      if (retries > 0) {
         const delay = (initialDelay * Math.pow(2, retries - 1)) + jitter;
         logRateLimit(`Rate limit retry ${retries}/${maxRetries} for ${axiosConfig.url}. Waiting ${delay.toFixed(0)}ms...`);
         await new Promise(resolve => setTimeout(resolve, delay));
      }
      
      const response = await axios(axiosConfig);
      
      // If we had to retry, log success on completion
      if (retries > 0) {
          logRateLimit(`Successfully completed request to ${axiosConfig.url} after ${retries} retries.`);
      }
      return response; // Success
    } catch (error) {
      if (error.response && error.response.status === 429 && retries < maxRetries) {
        retries++;
        logRateLimit(`Rate limit hit (429) for ${axiosConfig.url}. Attempting retry ${retries}/${maxRetries}. Request data: ${JSON.stringify(axiosConfig.data)}`);
        // Delay happens at the start of the next loop iteration
      } else {
        // Non-429 error or max retries reached
        if (error.response && error.response.status === 429) {
            logRateLimit(`Rate limit hit (429) for ${axiosConfig.url}. Max retries (${maxRetries}) reached. Failing request. Request data: ${JSON.stringify(axiosConfig.data)}`);
        }
        // Re-throw the error to be handled by the caller
        throw error;
      }
    }
  }
  // Should ideally not be reached if logic is correct, but as a safeguard:
  throw new Error(`Request failed after ${maxRetries} retries for ${axiosConfig.url}`);
} 
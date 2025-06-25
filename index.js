require('dotenv').config();
const { chromium } = require('playwright');
const cron = require('node-cron');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const express = require('express');
const { sendCsvToSlack, sendToGoogleSheets } = require('./send-to-slack');

// Add Google Sheets API requirements
const { google } = require('googleapis');
const sheets = google.sheets('v4');

// Browser installation check for deployment environments
async function checkBrowserInstallation() {
  try {
    console.log('Checking Playwright browser installation...');
    const { execSync } = require('child_process');
    execSync('npx playwright --version', { stdio: 'pipe' });
    console.log('Playwright browsers are available');
    return true;
  } catch (error) {
    console.log('Playwright browsers not found, attempting to install...');
    try {
      const { execSync } = require('child_process');
      execSync('npx playwright install chromium --with-deps', { stdio: 'inherit' });
      console.log('Playwright browsers installed successfully');
      return true;
    } catch (installError) {
      console.log('Failed to install Playwright browsers:', installError.message);
      console.log('This is normal in some deployment environments');
      return false;
    }
  }
}

// Initialize browser check on startup
checkBrowserInstallation().catch(console.error);

const STORAGE_STATE_PATH = path.join(__dirname, 'auth.json');
const SESSION_EXPIRY_PATH = path.join(__dirname, 'session-expiry.json');
const SLACK_CAMPAIGN_WEBHOOK_URL = 'YOUR_SLACK_WEBHOOK_URL_HERE'; // TODO: Replace with actual webhook URL
const RATE_LIMIT_LOG_PATH = path.join(__dirname, 'rate-limit-log.txt');
const FILTERED_CAMPAIGNS_PATH = path.join(__dirname, 'filtered-campaigns.json');
const CAMPAIGN_DETAILS_OUTPUT_PATH = path.join(__dirname, 'campaign-details-output.json');
const CAMPAIGN_DETAILS_CSV_PATH = path.join(__dirname, 'campaign-details.csv');

// Add Google Sheets configuration
const GOOGLE_SHEET_ID = '1zouhAsG8tPH33pbYLT1jNYbIw9oDK_ibs9o2RkhrBjA';

// Create Express server
const app = express();
const PORT = process.env.PORT || 3000;

// Configure middleware
app.use(express.json());

// Schedule to run every day at 12:05 AM IST (6:35 PM UTC)
console.log('Starting server with scheduled campaign detail checks at 12:05 AM IST daily...');
cron.schedule('35 18 * * *', async () => {
  console.log('Running scheduled campaign detail check...');
  
  let retryCount = 0;
  const maxRetries = 3;
  
  async function attemptCronCheck() {
    try {
      // Check session validity before scraping
      if (!isSessionValid()) {
        console.log('Cron Job: Session invalid or expired, performing login first...');
        await login(false);
        console.log('Cron Job: Login successful, proceeding with scraping...');
        await scrapeCampaignDetails();
      } else {
        console.log('Cron Job: Session valid, proceeding with scraping...');
        await scrapeCampaignDetails();
      }
      console.log('Scheduled campaign detail check completed successfully');
    } catch (error) {
      console.error('Cron Job: Error during scheduled run:', error.message);
      
      retryCount++;
      if (retryCount < maxRetries) {
        const delayMs = 5000 * retryCount;
        console.log(`Cron Job: Retry attempt ${retryCount}/${maxRetries} in ${delayMs/1000} seconds...`);
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return await attemptCronCheck();
      } else {
        console.error(`Cron Job: Failed after ${maxRetries} retry attempts.`);
      }
    } finally {
      console.log('Scheduled campaign detail check finished.');
    }
  }
  
  await attemptCronCheck();
});

// Remove initial run on startup and replace with simple server start message
console.log('Server started successfully');
console.log('Available endpoints:');
console.log('- GET /campaigns - Fetch current campaign data');
console.log('- GET /api/fetch-historical - Fetch historical data from start of month');
console.log('- GET /api/cron-check - Manual trigger for cron job');

// Configure Express routes
app.get('/campaigns', async (req, res) => {
  console.log('Campaigns API endpoint called');
  
  let retryCount = 0;
  const maxRetries = 3;
  
  async function attemptCampaignFetch() {
    try {
      if (!isSessionValid()) {
        console.log('API: No valid session, performing login first');
        await login(false);
        console.log('API: Login successful, proceeding with scraping...');
      }
      
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
      console.error('Error in campaigns endpoint:', error);
      
      retryCount++;
      if (retryCount < maxRetries) {
        const delayMs = 5000 * retryCount;
        console.log(`API: Retry attempt ${retryCount}/${maxRetries} in ${delayMs/1000} seconds...`);
        
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return await attemptCampaignFetch();
      } else {
        console.error(`API: Failed after ${maxRetries} retry attempts.`);
        return res.status(500).json({ 
          success: false, 
          error: 'Internal server error after multiple retry attempts' 
        });
      }
    }
  }
  
  await attemptCampaignFetch();
});

// Start Express server
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});

async function login(scrapeAfterLogin = true) {
  console.log('Starting login process...');
  
  // Enhanced browser launch options for deployment environments
  const browserOptions = {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-accelerated-2d-canvas',
      '--disable-dev-profile',
      '--window-size=1920,1080',
      '--disable-web-security',
      '--disable-features=VizDisplayCompositor'
    ]
  };

  // Add executable path for deployment environments if needed
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH) {
    browserOptions.executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  }

  let browser;
  try {
    browser = await chromium.launch(browserOptions);
  } catch (error) {
    console.error('Failed to launch browser:', error.message);
    console.log('Trying with system browser...');
    browser = await chromium.launch({
      ...browserOptions,
      channel: 'chrome' // Try using system Chrome
    });
  }

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
  });
  const page = await context.newPage();

  try {
    // Navigate to login page
    console.log(`Navigating to login page: ${process.env.LOGIN_URL}`);
    await page.goto(process.env.LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    console.log('Navigated to login page');

    // Take screenshot for debugging
    await page.screenshot({ path: 'login-page-debug.png' });
    console.log('Login page screenshot saved');

    // Fill login form
    console.log(`Filling login form with email: ${process.env.EMAIL}`);
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
      console.log(`Trying to find login button with selector: ${selector}`);
      const button = await page.$(selector);
      if (button && await button.isVisible()) {
        console.log(`Found login button with selector: ${selector}`);
        // Click button and wait for navigation
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
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
          page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
          continueButtons[1].click()
        ]);
      } else {
        // As a fallback, try clicking the last button in the form
        console.log('Trying to click the last button in the form...');
        const formButtons = await page.$$('form button');
        if (formButtons.length > 0) {
          const lastButton = formButtons[formButtons.length - 1];
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 60000 }),
            lastButton.click()
          ]);
        } else {
          // If that fails, take another screenshot to debug
          await page.screenshot({ path: 'login-failed-debug.png' });
          throw new Error('Could not find the login button with any selector');
        }
      }
    }
    
    // Take a screenshot after login to verify
    await page.screenshot({ path: 'post-login-debug.png' });
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
    
    // After login, conditionally scrape campaign information
    if (scrapeAfterLogin) {
      console.log('Auto-scraping campaign details after login...');
      await scrapeCampaignDetails(context);
    } else {
      console.log('Skipping auto-scrape after login (will be handled by caller)');
    }

  } catch (error) {
    console.error('Login failed:', error);
    // Take final error screenshot
    try {
      await page.screenshot({ path: 'login-error-debug.png' });
    } catch (screenshotError) {
      console.error('Failed to take error screenshot:', screenshotError);
    }
    throw error; // Rethrow to be handled by caller
  } finally {
    try {
      await context.close();
      await browser.close();
    } catch (closeError) {
      console.error('Error closing browser:', closeError);
    }
  }
}

// Add readFromGoogleSheets function before scrapeCampaignDetails
async function readFromGoogleSheets(sheetId) {
  try {
    // Initialize auth client
    const auth = new google.auth.GoogleAuth({
      keyFile: path.join(__dirname, 'google-credentials.json'),
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
    const client = await auth.getClient();

    // Read the spreadsheet
    const response = await sheets.spreadsheets.values.get({
      auth: client,
      spreadsheetId: sheetId,
      range: 'A:ZZ', // Read all columns
    });

    const rows = response.data.values || [];
    if (rows.length < 2) {
      return { headers: [], campaigns: {} };
    }

    // Parse headers (dates)
    const headerRow = rows[0];
    const headers = [];
    for (let i = 1; i < headerRow.length; i += 3) {
      if (headerRow[i]) {
        headers.push(headerRow[i]);
      }
    }

    // Parse campaign data
    const campaigns = {};
    for (let i = 2; i < rows.length; i++) {
      const row = rows[i];
      const campaignName = row[0];
      if (!campaignName) continue;

      campaigns[campaignName] = {};
      let headerIndex = 0;
      
      for (let j = 1; j < row.length; j += 3) {
        if (headerIndex >= headers.length) break;
        
        campaigns[campaignName][headers[headerIndex]] = {
          sent: parseInt(row[j]) || '',
          delivered: parseInt(row[j + 1]) || '',
          failed: parseInt(row[j + 2]) || ''
        };
        headerIndex++;
      }
    }

    return { headers, campaigns };
  } catch (error) {
    console.error('Error reading from Google Sheets:', error);
    throw error;
  }
}

async function scrapeCampaignDetails() {
  console.log('Starting campaign details scraping process...');
  
  // --- Clear previous output/log files --- 
  try {
    fs.writeFileSync(RATE_LIMIT_LOG_PATH, ''); // Clear rate limit log
    fs.writeFileSync(FILTERED_CAMPAIGNS_PATH, ''); // Clear filtered campaigns
    fs.writeFileSync(CAMPAIGN_DETAILS_OUTPUT_PATH, ''); // Clear campaign details output
    console.log('Cleared previous log and output files.');
  } catch (clearError) {
    console.error(`Error clearing files: ${clearError}`);
  }

  try {
    // Force a new login to ensure fresh token
    console.log('Performing fresh login to ensure valid token...');
    await login(false);
    
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
    let totalCampaigns = Infinity;
    
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
            tabType: "all"
          },
          timeout: 30000
        });
        
        const campaignsData = campaignsResponse.data;
        
        if (!campaignsData || !campaignsData.campaigns) {
          console.error('Invalid campaign data received:', campaignsData);
          throw new Error('Failed to fetch campaigns: Invalid data format');
        }
        
        allCampaigns.push(...campaignsData.campaigns);
        totalCampaigns = campaignsData.totalCampaigns || 0;
        
        if (campaignsData.newSkip > skip && allCampaigns.length < totalCampaigns) {
          skip = campaignsData.newSkip;
        } else {
          break;
        }
      }
      
      console.log(`Fetched total ${allCampaigns.length} campaigns.`);
      
      // Filter only API campaigns
      const apiCampaigns = allCampaigns.filter(campaign => 
        campaign.type === 'API' && campaign.status === 'LIVE'
      );
      
      console.log(`Found ${apiCampaigns.length} API/LIVE campaigns.`);
      
      // Calculate date range - get previous day's data
      const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
      const now = new Date(Date.now() + istOffset);
      console.log('Current time in IST:', now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      
      const today = new Date(now);
      today.setHours(0, 0, 0, 0);
      
      // Set toDate to start of current day in IST
      const toDate = new Date(today);
      
      // For filtering logic, we need to look back
      const filterFromDate = new Date(toDate);
      filterFromDate.setDate(toDate.getDate() - 8); // Look back 8 days for filtering

      // For actual data collection, we want previous day's data
      const dataFromDate = new Date(toDate);
      dataFromDate.setDate(toDate.getDate() - 1); // Get previous day's data
      const dataToDate = new Date(toDate); // End at current day start
      
      console.log('Data collection period (IST):', {
        currentTimeIST: now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
        today: today.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
        filterPeriod: {
          from: filterFromDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
          to: toDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
        },
        dataPeriod: {
          from: dataFromDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
          to: dataToDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
        }
      });
      
      // First, try to read existing data from Google Sheets
      let existingData;
      try {
        existingData = await readFromGoogleSheets(GOOGLE_SHEET_ID);
        console.log('Successfully read existing data from Google Sheets');
      } catch (error) {
        console.error('Failed to read from Google Sheets:', error);
        existingData = { headers: [], campaigns: {} };
      }

      // Process campaigns sequentially with delay to avoid rate limits
      const delayBetweenRequests = 2000; // 2 seconds delay
      const campaignDetails = [];
      
      for (const campaign of apiCampaigns) {
        console.log(`Fetching details for campaign: ${campaign.name} (ID: ${campaign._id})`);
        
        try {
          // First fetch data for filtering (last 8 days)
          const filterResponse = await axiosWithRetry({
            method: 'post',
            url: 'https://backend.aisensy.com/client/t1/api/campaign-chats',
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json;charset=UTF-8',
              'Origin': 'https://www.app.aisensy.com',
              'Referer': 'https://www.app.aisensy.com/'
            },
            data: {
              assistantId: process.env.ASSISTANT_ID || "6515621dfe38c80b4d35a1a7",
              campaignId: campaign._id,
              fromDate: filterFromDate.toISOString(),
              toDate: toDate.toISOString()
            },
            timeout: 30000
          });

          const filterData = filterResponse.data;
          
          // Apply filtering logic
          if (filterData && filterData.chats && filterData.chats.length >= 2) {
            const sortedFilterChats = filterData.chats.sort((a, b) => new Date(a.dayDate) - new Date(b.dayDate));
            
            // Check for 4 consecutive days with non-zero sent count
            let consecutiveDays = 0;
            let hasFourConsecutiveDays = false;
            
            for (let i = 0; i < sortedFilterChats.length; i++) {
              if (sortedFilterChats[i].sentChatCount > 0) {
                consecutiveDays++;
                if (consecutiveDays >= 4) {
                  hasFourConsecutiveDays = true;
                  break;
                }
              } else {
                consecutiveDays = 0;
              }
            }

            if (hasFourConsecutiveDays) {
              console.log(`Campaign ${campaign.name} - Has 4 consecutive days with messages`);
              
              // Now fetch previous day's data
              const dataResponse = await axiosWithRetry({
                method: 'post',
                url: 'https://backend.aisensy.com/client/t1/api/campaign-chats',
                headers: {
                  'Authorization': `Bearer ${token}`,
                  'Content-Type': 'application/json;charset=UTF-8',
                  'Origin': 'https://www.app.aisensy.com',
                  'Referer': 'https://www.app.aisensy.com/'
                },
                data: {
                  assistantId: process.env.ASSISTANT_ID || "6515621dfe38c80b4d35a1a7",
                  campaignId: campaign._id,
                  fromDate: dataFromDate.toISOString(),
                  toDate: dataToDate.toISOString()
                },
                timeout: 30000
              });

              const todayData = dataResponse.data;
              
              if (todayData && todayData.chats && todayData.chats.length > 0) {
                // Log all chats received for debugging
                console.log(`Received ${todayData.chats.length} data points for campaign ${campaign.name}`);
                todayData.chats.forEach((chat, index) => {
                  // Log all properties to find the correct delivered count property
                  console.log(`Data point ${index + 1} raw data:`, chat);
                  console.log(`Data point ${index + 1} formatted:`, {
                    date: new Date(chat.dayDate).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
                    sent: chat.sentChatCount,
                    // Check both possible property names for delivered count
                    delivered: chat.deliveredChatcount || chat.deliveredChatCount || chat.delivered,
                    failed: chat.failedChatCount
                  });
                });

                // Find the exact data point for our target date
                const targetData = todayData.chats.find(chat => {
                  const chatDate = new Date(chat.dayDate);
                  const targetDate = new Date(dataFromDate);
                  return chatDate.getDate() === targetDate.getDate() &&
                         chatDate.getMonth() === targetDate.getMonth() &&
                         chatDate.getFullYear() === targetDate.getFullYear();
                });

                if (!targetData) {
                  console.log(`No data found for target date ${dataFromDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} for campaign ${campaign.name}`);
                  return;
                }

                console.log(`Found data for target date:`, {
                  campaign: campaign.name,
                  date: new Date(targetData.dayDate).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
                  rawData: targetData
                });

                // Ensure we're getting numbers and handle undefined/null cases
                const sentCount = parseInt(targetData.sentChatCount) || 0;
                // Try different property names for delivered count
                const deliveredCount = parseInt(targetData.deliveredChatcount) || 
                                     parseInt(targetData.deliveredChatCount) || 
                                     parseInt(targetData.delivered) || 0;
                const failedCount = parseInt(targetData.failedChatCount) || 0;

                // Log the exact property we're using for delivered count
                console.log(`Property names in response for ${campaign.name}:`, {
                  availableProps: Object.keys(targetData),
                  deliveredPropValue: {
                    deliveredChatcount: targetData.deliveredChatcount,
                    deliveredChatCount: targetData.deliveredChatCount,
                    delivered: targetData.delivered
                  }
                });

                // Validate the numbers make sense
                if (deliveredCount + failedCount > sentCount) {
                  console.warn(`Warning: Numbers don't add up for campaign ${campaign.name}:`, {
                    sent: sentCount,
                    delivered: deliveredCount,
                    failed: failedCount,
                    total: deliveredCount + failedCount,
                    date: new Date(targetData.dayDate).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
                  });
                }

                campaignDetails.push({
                  campaignName: campaign.name,
                  campaignId: campaign._id,
                  date: new Date(targetData.dayDate),
                  sent: sentCount,
                  delivered: deliveredCount,
                  failed: failedCount
                });

                console.log(`Final processed stats for campaign ${campaign.name}:`, {
                  date: new Date(targetData.dayDate).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
                  sent: sentCount,
                  delivered: deliveredCount,
                  failed: failedCount,
                  rawDelivered: targetData.deliveredChatcount || targetData.deliveredChatCount || targetData.delivered
                });
              } else {
                console.log(`No chat data found for campaign ${campaign.name}`);
              }
            } else {
              console.log(`Campaign ${campaign.name} - Does NOT have 4 consecutive days with messages`);
            }
          } else {
            console.log(`Campaign ${campaign.name} - Not enough chat data (minimum 2 days required)`);
          }
          
          // Add delay after each API call
          console.log(`Waiting ${delayBetweenRequests}ms before next request...`);
          await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
          
        } catch (error) {
          console.error(`Error fetching details for campaign ${campaign.name}:`, error);
          await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
        }
      }
      
      // Prepare data for Google Sheets
      if (campaignDetails.length === 0) {
        console.log('No campaigns met the criteria for today');
        return null;
      }

      // Get previous day's date string in IST
      const dateString = `${dataFromDate.getDate()} ${dataFromDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' })}`;
      console.log('Using date string for data:', dateString);

      // Update headers if needed
      if (!existingData.headers.includes(dateString)) {
        existingData.headers.push(dateString);
      }

      // Update campaign data
      for (const detail of campaignDetails) {
        if (!existingData.campaigns[detail.campaignName]) {
          existingData.campaigns[detail.campaignName] = {};
        }
        existingData.campaigns[detail.campaignName][dateString] = {
          sent: detail.sent,
          delivered: detail.delivered,
          failed: detail.failed
        };
      }

      // Convert to CSV format
      const csvRows = [];
      
      // Create header rows
      const headerRow = ['Campaign'];
      existingData.headers.forEach(date => {
        headerRow.push(date, '', '');
      });
      csvRows.push(headerRow.join(','));
      
      // Create subheader row
      const subheaderRow = [''];
      existingData.headers.forEach(() => {
        subheaderRow.push('sent', 'Delivered', 'failed');
      });
      csvRows.push(subheaderRow.join(','));
      
      // Add data rows
      for (const [campaignName, campaignData] of Object.entries(existingData.campaigns)) {
        const row = [campaignName];
        existingData.headers.forEach(date => {
          const dayData = campaignData[date] || { sent: '', delivered: '', failed: '' };
          row.push(dayData.sent, dayData.delivered, dayData.failed);
        });
        csvRows.push(row.join(','));
      }
      
      // Write CSV and upload to Google Sheets
      try {
        const csvContent = csvRows.join('\n');
        fs.writeFileSync(CAMPAIGN_DETAILS_CSV_PATH, csvContent);
        console.log(`CSV file created at ${CAMPAIGN_DETAILS_CSV_PATH}`);
        
        try {
          await sendToGoogleSheets(CAMPAIGN_DETAILS_CSV_PATH, GOOGLE_SHEET_ID);
          console.log('Campaign data successfully sent to Google Sheets');
        } catch (error) {
          console.error('Failed to send data to Google Sheets:', error);
        }
      } catch (error) {
        console.error('Error writing CSV file:', error);
      }
      
      return campaignDetails;
      
    } catch (apiError) {
      console.error('Campaign API request failed:', apiError);
      throw apiError;
    }
  } catch (error) {
    console.error('Error during campaign detail scraping:', error);
    throw error;
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
  
  let retryCount = 0;
  const maxRetries = 3;
  
  async function attemptCronApiCheck() {
    try {
      // Check if we need to login first
      if (!isSessionValid()) {
        console.log('Cron API: No valid session, performing login first');
        await login(false); // Prevent duplicate scraping
        console.log('Cron API: Login successful, proceeding with scraping...');
      }
      
      // Log current time in IST before fetching
      const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
      const currentIST = new Date(Date.now() + istOffset);
      console.log('Current time in IST:', currentIST.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
      
      // Fetch campaign details (login is now handled inside scrapeCampaignDetails if needed)
      const campaignDetails = await scrapeCampaignDetails();
      
      if (campaignDetails) {
        return res.json({ 
          success: true, 
          campaigns: campaignDetails,
          timestamp: currentIST.toISOString(),
          istTime: currentIST.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
        });
      } else {
        return res.status(500).json({ 
          success: false, 
          error: 'Failed to retrieve campaign details',
          timestamp: currentIST.toISOString(),
          istTime: currentIST.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
        });
      }
    } catch (error) {
      console.error('Error in cron API endpoint:', error);
      
      // Retry logic for API endpoint
      retryCount++;
      if (retryCount < maxRetries) {
        const delayMs = 5000 * retryCount; // Increasing delay with each retry
        console.log(`Cron API: Retry attempt ${retryCount}/${maxRetries} in ${delayMs/1000} seconds...`);
        
        // Wait before retrying
        await new Promise(resolve => setTimeout(resolve, delayMs));
        return await attemptCronApiCheck();
      } else {
        console.error(`Cron API: Failed after ${maxRetries} retry attempts.`);
        return res.status(500).json({ 
          success: false, 
          error: 'Internal server error after multiple retry attempts',
          timestamp: new Date().toISOString()
        });
      }
    }
  }
  
  // Start the process
  await attemptCronApiCheck();
});

// Add a test endpoint to check date calculations
app.get('/api/check-dates', async (req, res) => {
  const istOffset = 5.5 * 60 * 60 * 1000;
  const now = new Date(Date.now() + istOffset);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  
  const dataFromDate = new Date(today);
  dataFromDate.setDate(today.getDate() - 2);
  
  const dataToDate = new Date(today);
  dataToDate.setDate(today.getDate() - 1);
  
  res.json({
    currentTimeIST: now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
    dateRanges: {
      dataFrom: dataFromDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }),
      dataTo: dataToDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })
    },
    dateString: `${dataFromDate.getDate()} ${dataFromDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' })}`
  });
});

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

// Add helper function to handle API calls with token refresh
async function makeAuthenticatedRequest(requestConfig, retryCount = 0) {
  const maxRetries = 3;
  try {
    return await axiosWithRetry(requestConfig);
  } catch (error) {
    if (error.response && error.response.status === 401 && retryCount < maxRetries) {
      console.log('Received 401 error, checking session validity...');
      
      // Only login if session is actually invalid
      if (!isSessionValid()) {
        console.log('Session is invalid, performing new login...');
        await login(false);
        
        // Get new token
        const storageState = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
        const cookies = storageState.cookies || [];
        let newToken = '';
        for (const cookie of cookies) {
          if (cookie.name === 'token') {
            newToken = cookie.value;
            break;
          }
        }
        
        if (!newToken) {
          throw new Error('Failed to get new token after login');
        }
        
        // Update request config with new token
        requestConfig.headers.Authorization = `Bearer ${newToken}`;
        console.log('Retrying request with new token...');
        return makeAuthenticatedRequest(requestConfig, retryCount + 1);
      } else {
        console.log('Session is still valid despite 401, might be a temporary issue. Retrying...');
        await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds before retry
        return makeAuthenticatedRequest(requestConfig, retryCount + 1);
      }
    }
    throw error;
  }
}

async function fetchHistoricalData() {
  console.log('Starting historical data fetch for test period...');
  
  try {
    // Get current date in IST
    const istOffset = 5.5 * 60 * 60 * 1000; // IST is UTC+5:30
    const today = new Date(new Date().getTime() + istOffset);
    console.log('Current IST date/time:', today.toISOString());
    
    const startDate = new Date(today);
    startDate.setDate(today.getDate() - 8);//changed here 6->8
    startDate.setHours(0, 0, 0, 0);
    
    // Set end date to today at start of day to get yesterday's complete data
    const endDate = new Date(today);
    endDate.setHours(0, 0, 0, 0);
    
    console.log(`Fetching data in IST:`);
    console.log(`From: ${startDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}`);
    console.log(`To: ${endDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })}`);
    
    // Try to read existing data from Google Sheets first
    console.log('Reading existing data from Google Sheets...');
    let existingData;
    try {
      existingData = await readFromGoogleSheets(GOOGLE_SHEET_ID);
      console.log('Successfully read existing data from Google Sheets');
    } catch (error) {
      console.log('No existing data found or error reading from sheets, starting fresh');
      existingData = { headers: [], campaigns: {} };
    }

    // Get current token
    const storageState = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
    const cookies = storageState.cookies || [];
    let token = '';
    for (const cookie of cookies) {
      if (cookie.name === 'token') {
        token = cookie.value;
        break;
      }
    }
    
    if (!token) {
      console.log('No token found, performing initial login...');
      await login(false);
      const newStorageState = JSON.parse(fs.readFileSync(STORAGE_STATE_PATH, 'utf8'));
      for (const cookie of newStorageState.cookies || []) {
        if (cookie.name === 'token') {
          token = cookie.value;
          break;
        }
      }
    }

    // Fetch all campaigns with auto-relogin
    console.log('Fetching campaign list...');
    const allCampaigns = [];
    let skip = 0;
    const rowsPerPage = 100;
    let totalCampaigns = Infinity;
    
    while (allCampaigns.length < totalCampaigns) {
      console.log(`Fetching campaigns batch: skip=${skip}, current total=${allCampaigns.length}`);
      const campaignsResponse = await makeAuthenticatedRequest({
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
          tabType: "all"
        },
        timeout: 30000
      });
      
      const campaignsData = campaignsResponse.data;
      if (!campaignsData || !campaignsData.campaigns) {
        throw new Error('Invalid campaign data received');
      }
      
      allCampaigns.push(...campaignsData.campaigns);
      totalCampaigns = campaignsData.totalCampaigns || 0;
      
      if (campaignsData.newSkip > skip && allCampaigns.length < totalCampaigns) {
        skip = campaignsData.newSkip;
      } else {
        break;
      }
    }
    
    // Filter API campaigns
    const apiCampaigns = allCampaigns.filter(campaign => 
      campaign.type === 'API' && campaign.status === 'LIVE'
    );
    
    console.log(`Found ${apiCampaigns.length} API/LIVE campaigns to process`);
    
    // Store all campaign data and track qualifications
    const campaignDetailsMap = new Map(); // Store all campaign data
    const everQualifiedCampaigns = new Set(); // Track campaigns that have ever qualified
    const delayBetweenRequests = 10000;
    let processedCampaigns = 0;
    const totalCampaignsToProcess = apiCampaigns.length;
    
    // Set up extended date range for filtering (looking back 8 days from end date)
    const filterFromDate = new Date(startDate);
    filterFromDate.setDate(filterFromDate.getDate() - 10); //changed here 8->10 Look back additional 8 days for filtering

    // Add existing campaigns to everQualifiedCampaigns set
    for (const campaignName of Object.keys(existingData.campaigns)) {
      everQualifiedCampaigns.add(campaignName);
    }

    for (const campaign of apiCampaigns) {
      processedCampaigns++;
      console.log(`\nProcessing campaign ${processedCampaigns}/${totalCampaignsToProcess}: ${campaign.name}`);
      
      try {
        // Fetch all data for the entire period at once
        console.log('Fetching campaign data for entire period...');
        const dataResponse = await makeAuthenticatedRequest({
          method: 'post',
          url: 'https://backend.aisensy.com/client/t1/api/campaign-chats',
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json;charset=UTF-8',
            'Origin': 'https://www.app.aisensy.com',
            'Referer': 'https://www.app.aisensy.com/'
          },
          data: {
            assistantId: process.env.ASSISTANT_ID || "6515621dfe38c80b4d35a1a7",
            campaignId: campaign._id,
            fromDate: filterFromDate.toISOString(),
            toDate: endDate.toISOString()
          },
          timeout: 30000
        });
        
        const campaignData = dataResponse.data;
        
        if (campaignData && campaignData.chats && campaignData.chats.length >= 2) {
          const sortedChats = campaignData.chats.sort((a, b) => new Date(a.dayDate) - new Date(b.dayDate));
          console.log(`Found ${sortedChats.length} days of chat data`);
          
          // Store data for all campaigns that have data
          campaignDetailsMap.set(campaign.name, sortedChats);
          
          // Check if campaign has ever qualified (4 consecutive days)
          for (let i = 0; i < sortedChats.length - 3; i++) {
            let consecutiveDays = 0;
            for (let j = i; j < sortedChats.length; j++) {
              if (sortedChats[j].sentChatCount > 0) {
                consecutiveDays++;
                if (consecutiveDays >= 4) {
                  everQualifiedCampaigns.add(campaign.name);
                  console.log(`Campaign ${campaign.name} qualifies (found 4 consecutive days with messages)`);
                  break;
                }
              } else {
                consecutiveDays = 0;
              }
            }
            if (everQualifiedCampaigns.has(campaign.name)) break;
          }
        } else {
          console.log('Not enough chat data (minimum 2 days required)');
        }
        
        console.log(`Waiting ${delayBetweenRequests}ms before next campaign...`);
        await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
        
      } catch (error) {
        console.error(`Error processing campaign ${campaign.name}:`, error.message);
        await new Promise(resolve => setTimeout(resolve, delayBetweenRequests));
      }
    }

    // Process data day by day
    const currentDate = new Date(startDate);
    const totalDays = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
    let processedDays = 0;
    
    while (currentDate < endDate) {
      processedDays++;
      console.log(`\n=== Processing day ${processedDays}/${totalDays}: ${currentDate.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' })} ===`);
      
      const campaignDetails = [];
      
      // Process data for all ever-qualified campaigns
      for (const campaignName of everQualifiedCampaigns) {
        const chatData = campaignDetailsMap.get(campaignName);
        if (chatData) {
          const dayData = chatData.find(chat => {
            const chatDate = new Date(chat.dayDate);
            return chatDate.getDate() === currentDate.getDate() &&
                   chatDate.getMonth() === currentDate.getMonth() &&
                   chatDate.getFullYear() === currentDate.getFullYear();
          });
          
          if (dayData) {
            campaignDetails.push({
              campaignName: campaignName,
              date: new Date(dayData.dayDate),
              sent: dayData.sentChatCount,
              delivered: dayData.deliveredChatcount,
              failed: dayData.failedChatCount
            });
          }
        }
      }

      // Format date string in IST - Use the actual date (not adding one day anymore)
      const dateString = `${currentDate.getDate()} ${currentDate.toLocaleString('en-US', { month: 'long', timeZone: 'Asia/Kolkata' })}`;
      
      if (campaignDetails.length > 0) {
        console.log(`Processing ${campaignDetails.length} campaigns for ${dateString}`);
        
        // Add header if not exists
        if (!existingData.headers.includes(dateString)) {
          existingData.headers.push(dateString);
        }
        
        // Clear any existing data for this date to prevent duplicates
        for (const campaignName of Object.keys(existingData.campaigns)) {
          if (existingData.campaigns[campaignName][dateString]) {
            delete existingData.campaigns[campaignName][dateString];
          }
        }
        
        // Add campaign data
        for (const detail of campaignDetails) {
          if (!existingData.campaigns[detail.campaignName]) {
            existingData.campaigns[detail.campaignName] = {};
          }
          existingData.campaigns[detail.campaignName][dateString] = {
            sent: detail.sent || 0,
            delivered: detail.delivered || 0,
            failed: detail.failed || 0
          };
        }

        // Convert to CSV and update sheet
        const csvRows = [];
        
        // Create header rows
        const headerRow = ['Campaign'];
        existingData.headers.sort((a, b) => {
          const [dayA, monthA] = a.split(' ');
          const [dayB, monthB] = b.split(' ');
          const dateA = new Date(`${monthA} ${dayA}, 2024`);
          const dateB = new Date(`${monthB} ${dayB}, 2024`);
          return dateA - dateB;
        }).forEach(date => {
          headerRow.push(date, '', '');
        });
        csvRows.push(headerRow.join(','));
        
        // Create subheader row
        const subheaderRow = [''];
        existingData.headers.forEach(() => {
          subheaderRow.push('sent', 'Delivered', 'failed');
        });
        csvRows.push(subheaderRow.join(','));
        
        // Add data rows for all ever-qualified campaigns
        for (const campaignName of everQualifiedCampaigns) {
          const row = [campaignName];
          existingData.headers.forEach(date => {
            const campaignData = existingData.campaigns[campaignName] || {};
            const dayData = campaignData[date] || { sent: '', delivered: '', failed: '' };
            row.push(dayData.sent, dayData.delivered, dayData.failed);
          });
          csvRows.push(row.join(','));
        }
        
        // Write to file and upload to Google Sheets
        const csvContent = csvRows.join('\n');
        fs.writeFileSync(CAMPAIGN_DETAILS_CSV_PATH, csvContent);
        
        try {
          await sendToGoogleSheets(CAMPAIGN_DETAILS_CSV_PATH, GOOGLE_SHEET_ID);
          console.log(`Successfully updated sheet with data for ${dateString}`);
        } catch (error) {
          console.error('Failed to update Google Sheets:', error.message);
        }
      } else {
        console.log(`No data found for ${dateString}`);
      }
      
      // Move to next day
      currentDate.setDate(currentDate.getDate() + 1);
    }
    
    console.log('\nHistorical data fetch completed');
    return existingData;
    
  } catch (error) {
    console.error('Error fetching historical data:', error);
    throw error;
  }
}

// Add endpoint to trigger historical data fetch
app.get('/api/fetch-historical', async (req, res) => {
  console.log('Historical data fetch endpoint called');
  
  try {
    const data = await fetchHistoricalData();
    res.json({
      success: true,
      message: 'Historical data fetch completed',
      data: data
    });
  } catch (error) {
    console.error('Error in historical fetch endpoint:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
}); 
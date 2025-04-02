require('dotenv').config();
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const FormData = require('form-data');

const CAMPAIGN_DETAILS_CSV_PATH = path.join(__dirname, 'campaign-details.csv');
const RATE_LIMIT_LOG_PATH = path.join(__dirname, 'rate-limit-log.txt');

// Main function
async function sendCsvToSlack() {
  console.log('Sending CSV file to Slack...');
  
  try {
    // Check if the CSV file exists
    if (!fs.existsSync(CAMPAIGN_DETAILS_CSV_PATH)) {
      console.error(`CSV file does not exist at ${CAMPAIGN_DETAILS_CSV_PATH}`);
      return;
    }
    
    // Send the CSV file to Slack
    await sendFileToSlack(CAMPAIGN_DETAILS_CSV_PATH, "Campaign Details Report");
    
  } catch (error) {
    console.error('Error sending CSV to Slack:', error.message);
    logRateLimit(`Error sending CSV to Slack: ${error.message}`);
  }
}

// Function to send a file directly to Slack using the new files.getUploadURLExternal API
async function sendFileToSlack(filePath, title) {
  console.log(`Sending file "${filePath}" to Slack using the new API method...`);
  
  // Get your Slack token from environment variable
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const webhookUrl = process.env.SLACK_WEBHOOK_URL;
  const channelId = process.env.SLACK_CHANNEL_ID;
  
  if (!slackToken && !webhookUrl) {
    console.error('Neither SLACK_BOT_TOKEN nor SLACK_WEBHOOK_URL environment variable is set');
    return;
  }
  
  if (!channelId && slackToken) {
    console.error('SLACK_CHANNEL_ID environment variable not set, but required when using bot token');
    return;
  }
  
  try {
    // Read file content
    const fileContent = fs.readFileSync(filePath);
    const fileName = path.basename(filePath);
    const fileSize = fileContent.length;
    
    console.log(`File details: name=${fileName}, size=${fileSize} bytes`);
    
    if (slackToken) {
      // Step 1: Get upload URL using files.getUploadURLExternal
      console.log('Step 1: Getting upload URL from Slack...');
      const getUrlResponse = await axios({
        method: 'post',
        url: 'https://slack.com/api/files.getUploadURLExternal',
        headers: {
          'Authorization': `Bearer ${slackToken}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        data: new URLSearchParams({
          filename: fileName,
          length: fileSize
        }).toString()
      });
      
      console.log('Response from files.getUploadURLExternal:', getUrlResponse.data);
      
      if (!getUrlResponse.data.ok) {
        throw new Error(`Failed to get upload URL: ${getUrlResponse.data.error}`);
      }
      
      const { upload_url, file_id } = getUrlResponse.data;
      
      // Step 2: Upload the file to the provided URL
      console.log(`Step 2: Uploading file to URL: ${upload_url}`);
      const uploadResponse = await axios({
        method: 'post',
        url: upload_url,
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        data: fileContent
      });
      
      console.log('Upload response status:', uploadResponse.status);
      
      if (uploadResponse.status !== 200) {
        throw new Error(`Failed to upload file: ${uploadResponse.statusText}`);
      }
      
      // Step 3: Complete the upload using files.completeUploadExternal
      console.log('Step 3: Completing upload and sharing in channel...');
      const completeResponse = await axios({
        method: 'post',
        url: 'https://slack.com/api/files.completeUploadExternal',
        headers: {
          'Authorization': `Bearer ${slackToken}`,
          'Content-Type': 'application/json'
        },
        data: {
          files: [{
            id: file_id,
            title: title || fileName
          }],
          channel_id: channelId,
          initial_comment: `${title || 'Campaign Details Report'} - Generated at ${new Date().toISOString()}`
        }
      });
      
      console.log('Response from files.completeUploadExternal:', completeResponse.data);
      
      if (completeResponse.data && completeResponse.data.ok) {
        console.log('File uploaded successfully to Slack!');
        console.log(`File ID: ${completeResponse.data.files[0].id}`);
        logRateLimit('File uploaded successfully to Slack!');
      } else {
        console.error('Error completing file upload:', completeResponse.data.error);
        logRateLimit(`Error completing file upload: ${completeResponse.data.error}`);
      }
    } else if (webhookUrl) {
      // Fallback to webhook if no token is available
      // Use webhook to send message with file content inline
      console.log('Using webhook URL to send message with file content...');
      
      // Convert CSV to text and format as code block
      const fileContentText = fileContent.toString('utf-8');
      const messageLines = fileContentText.split('\n');
      
      // Truncate if needed to avoid very large messages
      let displayContent = fileContentText;
      if (messageLines.length > 50) {
        displayContent = messageLines.slice(0, 50).join('\n') + '\n... (truncated)';
      }
      
      // Send webhook request
      const response = await axios.post(webhookUrl, {
        text: `*${title || 'Campaign Details Report'}*\n\`\`\`\n${displayContent}\n\`\`\``
      });
      
      if (response.status === 200) {
        console.log('Message sent successfully via webhook!');
        logRateLimit('Message sent successfully via webhook!');
      } else {
        console.error('Error sending message via webhook:', response.status);
        logRateLimit(`Error sending message via webhook: ${response.status}`);
      }
    }
  } catch (error) {
    console.error('Error in sendFileToSlack:', error.message);
    logRateLimit(`Error in sendFileToSlack: ${error.message}`);
    
    // Log more detailed error information if available
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', JSON.stringify(error.response.data, null, 2));
      logRateLimit(`Response status: ${error.response.status}, data: ${JSON.stringify(error.response.data)}`);
    }
  }
}

// Helper function for logging
function logRateLimit(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `${timestamp}: ${message}\n`;
  try {
    fs.appendFileSync(RATE_LIMIT_LOG_PATH, logMessage);
  } catch (err) {
    console.error("Failed to write to log:", err);
  }
}

// Execute the function if this script is run directly
if (require.main === module) {
  sendCsvToSlack()
    .then(() => {
      console.log('Script execution completed');
    })
    .catch(error => {
      console.error('Script execution failed:', error);
      process.exit(1);
    });
}

module.exports = sendCsvToSlack; 
<<<<<<< HEAD
# AISensy Campaign Details Scraper

This project automatically scrapes campaign details from the AISensy dashboard, processes them, and sends the data to Slack.

## Features

- Automated login to AISensy dashboard
- API-based scraping of campaign details
- Filtering of campaigns by type and status
- CSV generation for reporting
- Automatic Slack notification with campaign data
- Scheduled daily runs (12:00 AM IST)

## Setup

### Prerequisites

- Node.js 16+
- npm
- Slack workspace with permissions to create a bot or webhook

### Environment Variables

Create a `.env` file with the following variables:

```
EMAIL=your-aisensy-email
PASSWORD=your-aisensy-password
LOGIN_URL=https://www.app.aisensy.com/login
ASSISTANT_ID=your-assistant-id
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
SLACK_CHANNEL_ID=C0123ABCDEF
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/xxx/yyy/zzz
PORT=3000
```

### Installation

1. Clone the repository
2. Install dependencies:
   ```
   npm install
   ```
3. Run the script:
   ```
   npm start
   ```

## API Endpoints

- `GET /campaigns` - Fetch latest campaign details
- `GET /api/cron-check` - Trigger a manual update

## Deployment on Railway

This project is configured for deployment on Railway.app:

1. Create a new project on Railway
2. Link to your GitHub repository
3. Add the environment variables
4. Deploy

The application will automatically run the scraper at 12:00 AM IST daily and send reports to Slack.

## Slack Integration

The application supports two methods for sending data to Slack:

1. **Bot Token Method** (recommended):
   - Requires `SLACK_BOT_TOKEN` and `SLACK_CHANNEL_ID`
   - Sends proper file attachments to the specified channel

2. **Webhook Method**:
   - Requires only `SLACK_WEBHOOK_URL`
   - Sends data as a formatted message to the webhook's channel 
=======
# aisensy_campaign_datatransfer
daily data transfer of campaign stats
>>>>>>> b440b473502c87c5ca6d6ce23b1d1bc2688eb0f1

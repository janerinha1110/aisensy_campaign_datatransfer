# How to Fix Google Sheets Authentication Error

## The Problem
You're getting an "Invalid JWT Signature" error because your Google service account credentials have expired or been rotated.

## Solution: Generate New Service Account Key

### Step 1: Go to Google Cloud Console
1. Visit https://console.cloud.google.com/
2. Select your project: `aisensy-457608`

### Step 2: Navigate to Service Accounts
1. Go to **IAM & Admin** > **Service Accounts**
2. Find the service account: `aisensy@aisensy-457608.iam.gserviceaccount.com`

### Step 3: Create New Key
1. Click on the service account email
2. Go to the **Keys** tab
3. Click **Add Key** > **Create new key**
4. Choose **JSON** format
5. Click **Create**

### Step 4: Replace Credentials File
1. Download the new JSON file
2. Replace the existing `google-credentials.json` file in your project
3. Make sure the file is named exactly `google-credentials.json`

### Step 5: Verify Permissions
1. Go to your Google Sheet: https://docs.google.com/spreadsheets/d/1zouhAsG8tPH33pbYLT1jNYbIw9oDK_ibs9o2RkhrBjA
2. Click **Share** button
3. Add the service account email: `aisensy@aisensy-457608.iam.gserviceaccount.com`
4. Give it **Editor** permissions
5. Click **Done**

### Step 6: Test the Application
1. Run `npm start` to start the application
2. The application will now use port 3001 instead of 3000
3. Google Sheets errors will be handled gracefully and won't crash the application

## Alternative: Disable Google Sheets Temporarily
If you want to run the application without Google Sheets integration:

1. Comment out the Google Sheets call in `index.js` around line 706:
```javascript
// try {
//   await sendToGoogleSheets(CAMPAIGN_DETAILS_CSV_PATH, GOOGLE_SHEET_ID);
//   console.log('Campaign data successfully sent to Google Sheets');
// } catch (error) {
//   console.error('Failed to send data to Google Sheets:', error);
// }
```

The application will continue to work and save data to CSV files and Slack, just without Google Sheets integration. 
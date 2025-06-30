# External Cron API

This project now includes an external API that allows you to trigger the cron job from outside the main application. This is useful for:

- Manual testing of the cron job
- Triggering from external systems
- Integration with other services
- Remote execution via HTTP calls

## Setup

### 1. Environment Variables

Add these optional environment variables to your `.env` file:

```env
# External API Configuration
INTERNAL_SERVER_URL=http://localhost:3001    # URL of your main application
EXTERNAL_API_PORT=3002                       # Port for the external API
EXTERNAL_API_TOKEN=your-secure-token-here    # Optional: Token for external API authentication
CRON_SECRET=your-cron-secret-here           # Optional: Secret for internal cron endpoint
```

### 2. Run the Services

You have several options to run the services:

**Option 1: Run both services separately**
```bash
# Terminal 1: Run main application
npm start

# Terminal 2: Run external API
npm run external-api
```

**Option 2: Use the CLI trigger (requires main app running)**
```bash
# Make sure main app is running first
npm start

# Then trigger cron from another terminal
npm run trigger-cron
```

## API Endpoints

### External API Server (Port 3002)

#### GET `/`
- **Description**: API documentation and status
- **Usage**: `curl http://localhost:3002/`

#### GET `/health`
- **Description**: Health check for external API
- **Usage**: `curl http://localhost:3002/health`

#### GET `/status`
- **Description**: Check if internal server is reachable
- **Usage**: `curl http://localhost:3002/status`

#### POST `/trigger-cron`
- **Description**: Trigger cron job with Authorization header
- **Usage**: 
  ```bash
  curl -X POST http://localhost:3002/trigger-cron \
    -H "Authorization: Bearer YOUR_TOKEN"
  ```

#### GET `/trigger-cron?token=TOKEN`
- **Description**: Trigger cron job with query parameter
- **Usage**: 
  ```bash
  curl "http://localhost:3002/trigger-cron?token=YOUR_TOKEN"
  ```

## Usage Examples

### 1. Basic Usage (No Authentication)

If you haven't set `EXTERNAL_API_TOKEN`, you can call without authentication:

```bash
# Using POST
curl -X POST http://localhost:3002/trigger-cron

# Using GET
curl http://localhost:3002/trigger-cron
```

### 2. With Authentication

If you've set `EXTERNAL_API_TOKEN=mySecretToken123`:

```bash
# Using POST with Bearer token
curl -X POST http://localhost:3002/trigger-cron \
  -H "Authorization: Bearer mySecretToken123"

# Using GET with query parameter
curl "http://localhost:3002/trigger-cron?token=mySecretToken123"
```

### 3. Using the CLI Tool

```bash
# Simple trigger
npm run trigger-cron

# Or directly
node trigger-cron.js
```

### 4. From Browser

You can also trigger via browser (if no authentication required):
```
http://localhost:3002/trigger-cron
```

## Response Format

All endpoints return JSON responses:

### Success Response
```json
{
  "success": true,
  "message": "Cron job triggered successfully",
  "data": {
    "campaigns": [...],
    "timestamp": "2024-01-01T12:00:00.000Z"
  },
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

### Error Response
```json
{
  "success": false,
  "error": "Error description",
  "details": "Additional error details",
  "timestamp": "2024-01-01T12:00:00.000Z"
}
```

## Security

### Authentication Options

1. **No Authentication**: Set neither `EXTERNAL_API_TOKEN` nor `CRON_SECRET`
2. **External API Token**: Set `EXTERNAL_API_TOKEN` to require authentication for external calls
3. **Cron Secret**: Set `CRON_SECRET` to match your internal server's cron secret
4. **Both**: Use both for maximum security

### CORS

The external API includes CORS headers allowing cross-origin requests. In production, you may want to restrict this.

## Troubleshooting

### Common Issues

1. **Connection Refused**
   - Make sure the main application is running on the correct port
   - Check `INTERNAL_SERVER_URL` environment variable

2. **401 Unauthorized**
   - Check your `EXTERNAL_API_TOKEN` configuration
   - Ensure you're sending the correct token

3. **Timeout**
   - The cron job can take up to 5 minutes to complete
   - This is normal for large datasets

### Logs

Both services provide detailed logging:

```bash
# External API logs
npm run external-api

# CLI trigger logs
npm run trigger-cron
```

### Testing

Check if everything is working:

```bash
# Test external API health
curl http://localhost:3002/health

# Test internal server connection
curl http://localhost:3002/status

# Test cron trigger
curl -X POST http://localhost:3002/trigger-cron
```

## Integration Examples

### Webhook Integration

You can integrate this with webhook services:

```javascript
// Example webhook handler
app.post('/webhook', async (req, res) => {
  try {
    const response = await axios.post('http://localhost:3002/trigger-cron', {}, {
      headers: {
        'Authorization': 'Bearer ' + process.env.EXTERNAL_API_TOKEN
      }
    });
    res.json({ success: true, data: response.data });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});
```

### Scheduled External Trigger

```javascript
// Example: Trigger every hour from external service
const cron = require('node-cron');

cron.schedule('0 * * * *', async () => {
  try {
    await axios.post('http://localhost:3002/trigger-cron');
    console.log('Cron triggered successfully');
  } catch (error) {
    console.error('Failed to trigger cron:', error.message);
  }
});
```

## Production Deployment

For production deployment:

1. Set strong tokens for `EXTERNAL_API_TOKEN` and `CRON_SECRET`
2. Use HTTPS for all communications
3. Restrict CORS origins if needed
4. Monitor logs for security issues
5. Use process managers like PM2 for both services

```bash
# Example PM2 configuration
pm2 start index.js --name "main-app"
pm2 start external-cron-client.js --name "external-api"
``` 
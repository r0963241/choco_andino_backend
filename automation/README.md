# Automation Setup

This project includes two automation flows that interact with the backend.

## 1) Scheduled backend automation (hourly)

Implemented in `backend/index.js`:

- Every hour, the backend checks bookings where:
  - `status = 'confirmed'`
  - checkout date is before today
- Those bookings are auto-updated to:
  - `status = 'completed'`
  - `action = 'system_auto_completed'`
  - `action_at = NOW()`

This runs once at server startup and then every hour.

## 2) n8n / Make / Zapier webhook automation

Implemented in `backend/routes/bookings.js` and `backend/index.js`:

- The backend sends POST webhooks for booking events:
  - `booking_created`
  - `booking_status_updated`
  - `booking_cancelled`
  - `bookings_auto_completed`

### Environment variable

Set this in your backend `.env` file:

`AUTOMATION_WEBHOOK_URL=https://your-n8n-or-zapier-webhook-url`

If not set, webhook sending is skipped.

### n8n example workflow

Import this file into n8n:

- `backend/automation/n8n-booking-events-workflow.json`

After import:

1. Open the `Webhook Trigger` node and copy its production URL.
2. Set `AUTOMATION_WEBHOOK_URL` in backend `.env` to that URL.
3. In `Send Notification`, replace the placeholder destination URL with Slack/Discord/email API endpoint or your own webhook target.
4. Activate the workflow.

### Event payload format

Example payload sent by backend:

```json
{
  "event_type": "booking_status_updated",
  "source": "choco_andino_backend",
  "occurred_at": "2026-08-11T20:00:00.000Z",
  "payload": {
    "booking_id": 15,
    "owner_id": 11,
    "status": "confirmed",
    "action": "owner_confirmed"
  }
}
```

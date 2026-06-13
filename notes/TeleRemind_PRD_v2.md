# TeleRemind — Product Requirements Document (PRD)

> **Version:** 2.0  
> **Changes from v1.0:** Supabase replaced with Firebase Firestore · Telegram Bot explicitly hosted inside Cloudflare Worker · Full noob-friendly hosting guide added (Section 15)  
> **Purpose:** Complete specification for an AI to generate all three codebases — Website, Cloudflare Worker (includes Bot), Firebase setup — without any additional context.

---

## 1. Product Overview

TeleRemind is a web-based reminder app where users set reminders on a website and receive notifications via browser AND Telegram message. All data is stored in Firebase Firestore. A Cloudflare Worker is the secure backend API, cron scheduler, AND Telegram Bot webhook handler all in one. There is no separate bot server.

### Three Codebases to Generate

| Codebase | File Location | Hosted On |
|---|---|---|
| Website | `website/index.html` | GitHub Pages (free) |
| Cloudflare Worker + Bot | `worker/` (multiple .js files) | Cloudflare Workers (free) |
| Firebase Config | `firebase/firestore.rules` + collection setup | Firebase (free Spark plan) |

---

## 2. Tech Stack

| Layer | Technology | Reason |
|---|---|---|
| Frontend | Vanilla HTML / CSS / JS | GitHub Pages compatible, no build step |
| Backend + Bot | Cloudflare Worker (JS) | Free, serverless, hosts bot webhook too |
| Database | Firebase Firestore (NoSQL) | Free Spark plan, document model, REST API |
| Auth | Firebase Auth (anonymous or none) | Optional — username-based is enough |
| Notifications | Telegram Bot API | Free, reliable push delivery |
| Website Hosting | GitHub Pages | Free static hosting |

---

## 3. Architecture Overview

```
[Website — GitHub Pages]
        │
        ├── User enters @telegram_username
        ├── Checks connection status via Worker
        ├── Creates / views / deletes reminders
        ├── Shows connected / disconnected badge
        │
        ▼
[Cloudflare Worker — workers.dev]  ← SINGLE deployment, does everything
        │
        ├── POST /webhook        → Receives Telegram messages (Bot lives here)
        ├── GET  /check-user     → Checks Firebase for registered username
        ├── POST /save-reminder  → Writes reminder to Firebase Firestore
        ├── GET  /get-reminders  → Reads reminders from Firebase Firestore
        ├── DELETE /delete-reminder → Soft deletes reminder in Firebase
        └── CRON (every 1 min)  → Finds due reminders → sends Telegram messages
        │
        ▼
[Firebase Firestore — Google Cloud]
        │
        ├── Collection: users      → one document per username
        └── Collection: reminders  → one document per reminder
        │
        ▼
[Telegram Bot API — api.telegram.org]
        └── sendMessage → delivers reminder to user's Telegram chat
```

---

## 4. Firebase Firestore — Data Structure

Firebase is a NoSQL document database. There are no SQL tables. Instead use **Collections** (like folders) and **Documents** (like JSON files inside folders).

### Collection: `users`

Document ID = the username (e.g. document ID is `mayank`)

```json
{
  "username":   "mayank",
  "chat_id":    123456789,
  "first_name": "Mayank",
  "is_active":  true,
  "joined_at":  "2024-06-01T10:00:00Z",
  "last_seen":  "2024-06-10T08:30:00Z"
}
```

Fields explained:
- `username` — Telegram username without @ (also the document ID)
- `chat_id` — Telegram numeric user ID, needed to send messages
- `first_name` — From Telegram profile, shown on website greeting
- `is_active` — false if user sends /stop command
- `joined_at` — First time they sent /start
- `last_seen` — Updated every time they send any message to bot

### Collection: `reminders`

Document ID = auto-generated Firebase ID

```json
{
  "id":          "auto-generated-firebase-id",
  "username":    "mayank",
  "title":       "Doctor appointment",
  "description": "Bring insurance card",
  "remind_at":   "2024-06-20T10:00:00Z",
  "is_sent":     false,
  "is_deleted":  false,
  "recurrence":  "none",
  "created_at":  "2024-06-10T08:00:00Z",
  "sent_at":     null
}
```

Fields explained:
- `username` — links reminder to a user (used for queries)
- `remind_at` — ISO 8601 datetime string when to fire
- `is_sent` — set to true after Telegram message is delivered
- `is_deleted` — soft delete flag, never hard delete
- `recurrence` — one of: `none`, `daily`, `weekly`, `monthly`
- `sent_at` — filled in when actually delivered

### Firestore Indexes (create in Firebase Console)

Firebase requires composite indexes for multi-field queries. Create these manually in Firebase Console > Firestore > Indexes:

```
Collection: reminders
Fields: username (Ascending), is_deleted (Ascending), remind_at (Ascending)
Query scope: Collection

Collection: reminders
Fields: is_sent (Ascending), is_deleted (Ascending), remind_at (Ascending)
Query scope: Collection
```

### Firestore Security Rules (`firebase/firestore.rules`)

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // Users collection — only Worker (admin) can write
    match /users/{username} {
      allow read: if false;   // only Worker reads/writes via Admin SDK
      allow write: if false;
    }

    // Reminders collection — only Worker (admin) can read/write
    match /reminders/{reminderId} {
      allow read: if false;
      allow write: if false;
    }
  }
}
```

Note: The Cloudflare Worker uses Firebase Admin REST API with a Service Account, which bypasses these rules entirely. These rules block direct browser access for security.

---

## 5. Firebase — Worker Integration Method

The Cloudflare Worker CANNOT use the standard Firebase Admin SDK (it's Node.js only). Instead it uses the **Firebase Firestore REST API** with a **Service Account JWT**.

### How the Worker authenticates with Firebase:

1. Worker holds the Firebase Service Account JSON credentials as environment secrets
2. On each request needing Firebase, Worker generates a short-lived OAuth2 JWT token
3. Worker uses that token to call the Firestore REST API

### Firestore REST API Base URL:

```
https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents
```

### Example — Read a document:

```
GET https://firestore.googleapis.com/v1/projects/MY_PROJECT/databases/(default)/documents/users/mayank
Authorization: Bearer {jwt_token}
```

### Example — Create a document:

```
POST https://firestore.googleapis.com/v1/projects/MY_PROJECT/databases/(default)/documents/reminders
Authorization: Bearer {jwt_token}
Content-Type: application/json

{
  "fields": {
    "username":   { "stringValue": "mayank" },
    "title":      { "stringValue": "Doctor appointment" },
    "remind_at":  { "stringValue": "2024-06-20T10:00:00Z" },
    "is_sent":    { "booleanValue": false },
    "is_deleted": { "booleanValue": false },
    "recurrence": { "stringValue": "none" }
  }
}
```

### Example — Query (runQuery):

```
POST https://firestore.googleapis.com/v1/projects/MY_PROJECT/databases/(default)/documents:runQuery
Authorization: Bearer {jwt_token}

{
  "structuredQuery": {
    "from": [{ "collectionId": "reminders" }],
    "where": {
      "compositeFilter": {
        "op": "AND",
        "filters": [
          { "fieldFilter": { "field": { "fieldPath": "username" }, "op": "EQUAL", "value": { "stringValue": "mayank" } } },
          { "fieldFilter": { "field": { "fieldPath": "is_deleted" }, "op": "EQUAL", "value": { "booleanValue": false } } }
        ]
      }
    },
    "orderBy": [{ "field": { "fieldPath": "remind_at" }, "direction": "ASCENDING" }]
  }
}
```

---

## 6. Cloudflare Worker — Environment Variables

Set these as Cloudflare Worker Secrets (never hardcode in source):

```
TELEGRAM_BOT_TOKEN         → From @BotFather (e.g. 123456:ABCdef...)
FIREBASE_PROJECT_ID        → From Firebase project settings
FIREBASE_CLIENT_EMAIL      → From Firebase service account JSON
FIREBASE_PRIVATE_KEY       → From Firebase service account JSON (the long RSA key)
WEBSITE_URL                → e.g. https://yourname.github.io/teleremind
```

---

## 7. Cloudflare Worker — File Structure

```
worker/
├── index.js          ← Main router: handles all HTTP routes + cron trigger
├── firebase.js       ← Firebase Firestore REST API helpers + JWT auth
├── telegram.js       ← Telegram sendMessage + parseWebhook helpers
├── cron.js           ← Cron logic: query due reminders, send, update Firebase
└── wrangler.toml     ← Cloudflare config (cron schedule, env vars)
```

---

## 8. Cloudflare Worker — API Routes

### `POST /webhook` — Telegram Bot Handler

This IS the Telegram Bot. Telegram calls this URL automatically when any user messages the bot.

**Step-by-step logic:**

1. Parse JSON body from Telegram update object
2. Extract: `update.message.from.username`, `update.message.from.first_name`, `update.message.chat.id`, `update.message.text`
3. If `text` starts with `/start`:
   - Write to Firebase `users` collection (document ID = username):
     ```json
     { username, chat_id, first_name, is_active: true, joined_at: now(), last_seen: now() }
     ```
   - Use `SET` with merge so existing users just update `last_seen`
   - Reply via Telegram API with welcome message (see Section 10)
4. If `text` starts with `/stop`:
   - Update Firebase: `users/{username}` → `{ is_active: false }`
   - Reply with disconnection message
5. If `text` starts with `/list`:
   - Query Firebase `reminders` where `username == X AND is_sent == false AND is_deleted == false`
   - Reply with formatted list
6. If username is null/empty in Telegram update:
   - Reply: "Please set a public username in Telegram Settings first, then send /start again."
7. Always respond with HTTP 200 (Telegram requires this)

---

### `GET /check-user?username=mayank`

**Logic:**

1. Fetch Firebase document: `users/{username}`
2. If document exists AND `is_active == true`:
   ```json
   { "connected": true, "first_name": "Mayank", "joined_at": "..." }
   ```
3. If document exists but `is_active == false`:
   ```json
   { "connected": false, "reason": "inactive" }
   ```
4. If document does not exist:
   ```json
   { "connected": false }
   ```

---

### `POST /save-reminder`

**Request body:**
```json
{
  "username":    "mayank",
  "title":       "Team standup",
  "description": "Zoom link: https://...",
  "remind_at":   "2024-06-15T09:00:00Z",
  "recurrence":  "daily"
}
```

**Logic:**

1. Verify `users/{username}` exists in Firebase — if not return `{ error: "User not registered", code: 404 }`
2. Validate `remind_at` is in the future — if not return `{ error: "Time must be in the future", code: 400 }`
3. Validate `recurrence` is one of: `none`, `daily`, `weekly`, `monthly`
4. Create new document in Firebase `reminders` collection with all fields plus `is_sent: false`, `is_deleted: false`, `created_at: now()`
5. Return: `{ "success": true, "id": "firebase-doc-id" }`

---

### `GET /get-reminders?username=mayank`

**Logic:**

1. Query Firebase `reminders` collection:
   - `username == mayank`
   - `is_deleted == false`
   - Order by `remind_at` ascending
2. Return array of reminder objects (convert Firebase field format to plain JSON)

---

### `DELETE /delete-reminder`

**Request body:**
```json
{ "id": "firebase-doc-id", "username": "mayank" }
```

**Logic:**

1. Fetch document `reminders/{id}`
2. Verify `document.username == request.username` (security check — user can only delete their own)
3. Update field: `is_deleted = true`
4. Return: `{ "success": true }`

---

### Cron Handler — Every 1 Minute

Triggered by Cloudflare's built-in scheduler. NOT an HTTP route.

**Logic:**

Query Firebase `reminders` where:
- `is_sent == false`
- `is_deleted == false`
- `remind_at <= now()` (current ISO timestamp)

For each matching document:

1. Fetch the user's `chat_id` from `users/{username}`
2. If `user.is_active == false` → skip this reminder
3. Call Telegram `sendMessage` API with formatted message (see Section 10)
4. If Telegram call succeeds:
   - Update reminder: `is_sent = true`, `sent_at = now()`
5. If Telegram call fails:
   - Do NOT update `is_sent` → will retry next minute
6. Handle recurrence:
   - `daily` → create new reminder document with `remind_at + 1 day`
   - `weekly` → create new reminder document with `remind_at + 7 days`
   - `monthly` → create new reminder document with `remind_at + 1 month`
   - `none` → no new document created
7. Cleanup pass (also run every cron cycle):
   - Query reminders where `is_sent == true AND is_deleted == false AND sent_at < now() - 24 hours`
   - For each: set `is_deleted = true`

---

## 9. Cloudflare `wrangler.toml`

```toml
name = "teleremind-worker"
main = "index.js"
compatibility_date = "2024-01-01"

[triggers]
crons = ["* * * * *"]

[vars]
WEBSITE_URL = "https://yourname.github.io/teleremind"
FIREBASE_PROJECT_ID = "your-firebase-project-id"

# These must be set as secrets via CLI, NOT here:
# wrangler secret put TELEGRAM_BOT_TOKEN
# wrangler secret put FIREBASE_CLIENT_EMAIL
# wrangler secret put FIREBASE_PRIVATE_KEY
```

---

## 10. Telegram Bot — Message Formats

### On `/start`:

```
👋 Hello [first_name]!

You're now connected to TeleRemind ✅

📌 Your username: @[username]
🌐 Set reminders at:
[WEBSITE_URL]

You'll receive all reminders here on Telegram!

━━━━━━━━━━━━━━━━
Commands:
/start — Connect or reconnect
/stop  — Stop receiving reminders
/list  — View upcoming reminders
```

### On `/stop`:

```
❌ Disconnected

You won't receive reminders anymore.
Send /start anytime to reconnect.
```

### On reminder fire (sent by cron):

```
⏰ Reminder

📌 [Title]
📝 [Description — only if not empty]
🕐 [remind_at formatted as "June 20, 2024 at 10:00 AM"]
🔁 [Recurrence type — only if not "none"]

— TeleRemind
```

### On `/list`:

```
📋 Your Upcoming Reminders

1. Team standup — Today, 9:00 AM 🔁 Daily
2. Doctor appointment — Tomorrow, 10:30 AM
3. Pay electricity bill — Jun 20, 6:00 PM

Total: 3 pending reminder(s)
```

If no reminders:

```
📭 No upcoming reminders.
Visit the website to add some!
[WEBSITE_URL]
```

---

## 11. Website — Full Specification

### Design System

- **Style:** Glassmorphism, light theme
- **Primary colors:** Purple `#7C3AED`, `#A78BFA`, `#C4B5FD`
- **Accent colors:** Blue `#60A5FA`, `#B9D9DC`
- **Background:** White `#FFFFFF` with soft purple-blue gradient
- **Font:** `Syne` (headings) + `DM Sans` (body) — import from Google Fonts
- **Border radius:** 16px cards, 12px inputs, 8px buttons
- **Glass cards:** `backdrop-filter: blur(20px)`, `background: rgba(255,255,255,0.7)`, soft border
- **Shadows:** Soft purple-tinted box shadows
- **Icons:** Colorful inline SVG only — no emoji, no icon font libraries
- **Animations:** Smooth fade-in on load, slide-up on card add, fade-out on delete

---

### Layout — Section by Section

#### Navbar

- Left: "TeleRemind" logo with purple gradient text + small bell SVG icon
- Right: Connection status badge
- Sticky on scroll, glass background

#### Connection Status Badge (in navbar)

```
[Green dot SVG] Connected as @mayank          ← when registered in Firebase
[Red dot SVG]   Not Connected                 ← username not found
[Yellow dot SVG] Checking...                  ← loading state
```

#### Hero / Connect Banner

Shown only when NOT connected:

```
[Large Telegram SVG icon — colorful blue]

Connect your Telegram to get started

[Input field: Your Telegram username (without @)]
[Check Connection — purple gradient button]

First time? Open @TeleRemindBot on Telegram, send /start, then come back here.
[Open Bot button — outlined style]
```

Shown when connected (replace the banner):

```
[Green check SVG]  Connected as @mayank  •  [Disconnect link]
Last synced: just now
```

#### Add Reminder Form

Only render this section when user is connected.

```
┌─────────────────────────────────────────────┐
│  [Bell SVG]  New Reminder                   │
├─────────────────────────────────────────────┤
│  Title *                                    │
│  ┌─────────────────────────────────────┐    │
│  │  e.g. Doctor appointment            │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Description (optional)                     │
│  ┌─────────────────────────────────────┐    │
│  │                                     │    │
│  └─────────────────────────────────────┘    │
│                                             │
│  Date & Time *          Recurrence          │
│  ┌──────────────────┐  ┌────────────────┐   │
│  │  datetime-local  │  │  None       ▼  │   │
│  └──────────────────┘  └────────────────┘   │
│                                             │
│  [+ Add Reminder ────────────── button]     │
└─────────────────────────────────────────────┘
```

Recurrence options: `None`, `Daily`, `Weekly`, `Monthly`

Validation rules:
- Title: required, min 1 char
- remind_at: must be at least 2 minutes in the future
- Show red inline error text below field on failure
- Disable submit button while loading

#### Reminders List

Only render when connected.

Two tab pills: `Upcoming (3)` | `Sent`

**Upcoming reminder card:**

```
┌─────────────────────────────────────────────────┐
│  [Clock SVG — purple]  Team standup meeting     │
│                        Daily · Jun 15, 9:00 AM  │
│                                                 │
│  📝 Zoom link: https://zoom.us/...              │
│                                                 │
│  [Hourglass SVG] in 2 hours 15 minutes          │
│                                    [× Delete]   │
└─────────────────────────────────────────────────┘
```

**Sent reminder card:**

```
┌─────────────────────────────────────────────────┐
│  [Check SVG — green]  Pay electricity bill      │  ← opacity 0.5, no delete
│                       Sent Jun 10 at 6:00 PM    │
└─────────────────────────────────────────────────┘
```

**Empty state:**

```
[Calendar SVG — large, colorful]
No upcoming reminders yet
Add your first one above!
```

#### Toast Notifications (in-page)

Appear top-right, auto-dismiss after 3 seconds:
- Success: green glass toast with check SVG
- Error: red glass toast with X SVG
- Info: purple glass toast with info SVG

#### Footer

```
Built with Firebase · Cloudflare Workers · Telegram Bot API
[GitHub SVG link]  [Telegram SVG link]
```

---

### JavaScript Logic

#### On Page Load:

```
1. Read username from localStorage key "teleremind_username"
2. If username exists:
   → Show "Checking..." badge
   → Call Worker GET /check-user?username={username}
   → If connected: show green badge, call loadReminders()
   → If not connected: clear localStorage, show connect form
3. If no username in localStorage:
   → Show connect banner immediately
4. Request Notification permission (browser push) — one time
5. Start interval: every 60 seconds → call refreshReminders()
6. Start interval: every 60 seconds → call checkBrowserNotifications()
7. On visibilitychange → if tab becomes visible → call refreshReminders()
```

#### On Connect Button Click:

```
1. Read input value, sanitize: remove @, trim, lowercase
2. If empty → show inline error "Please enter your Telegram username"
3. Show loading spinner on button
4. Call Worker GET /check-user?username={value}
5. If response.connected == true:
   → Save username to localStorage
   → Hide connect banner
   → Show green connected badge
   → Call loadReminders()
   → Show success toast "Connected as @{username}!"
6. If connected == false AND reason == "inactive":
   → Show message: "Your account is disconnected. Send /start to the bot to reconnect."
   → Show Open Bot button
7. If connected == false:
   → Show message: "Username not found. Please open the bot, send /start, then try again."
   → Show Open Bot button
```

#### On Add Reminder Submit:

```
1. Read all form fields
2. Validate: title not empty, remind_at is future, recurrence is valid
3. Show loading on button
4. Call Worker POST /save-reminder with JSON body
5. On success:
   → Clear form fields
   → Show success toast "Reminder saved! You'll get a Telegram message at {time}."
   → Call loadReminders()
6. On error:
   → Show error toast with error message from Worker
```

#### On Delete Button Click:

```
1. Show confirm: "Delete this reminder?"
2. Call Worker DELETE /delete-reminder with { id, username }
3. On success:
   → Animate card out (opacity 0 + slide down)
   → Remove from DOM after animation
   → Show toast "Reminder deleted"
```

#### loadReminders() / refreshReminders():

```
1. Call Worker GET /get-reminders?username={username}
2. Split into: upcoming (is_sent=false), sent (is_sent=true)
3. Re-render both tabs
4. Update tab badge counts
5. For each upcoming reminder, compute "time remaining" string:
   < 1 hour   → "in X minutes"
   < 24 hours → "in X hours Y minutes"
   otherwise  → "in X days"
6. Update "Last synced: just now"
```

#### checkBrowserNotifications() — runs every 60s:

```javascript
reminders.forEach(r => {
  const diff = new Date(r.remind_at) - new Date();
  if (diff >= 0 && diff < 60000 && Notification.permission === "granted") {
    new Notification("⏰ " + r.title, {
      body: r.description || "TeleRemind",
      icon: "/icon.png"
    });
  }
});
```

---

## 12. Complete User Flow

```
Step 1:  User visits website for the first time
         → Sees "Connect your Telegram" banner

Step 2:  User opens Telegram → searches for the bot → sends /start
         → Cloudflare Worker /webhook receives the message
         → User document created in Firebase users collection
         → Bot replies with welcome message + website link

Step 3:  User returns to website
         → Types their Telegram username (without @)
         → Clicks "Check Connection"
         → Worker fetches users/{username} from Firebase
         → Connected badge appears in green
         → Username saved to localStorage

Step 4:  User fills in Add Reminder form
         → Title: "Doctor appointment"
         → Date/Time: June 20, 10:00 AM
         → Recurrence: None
         → Clicks Add Reminder

Step 5:  Worker validates input and writes to Firebase reminders collection
         → New reminder document created
         → Appears in Upcoming tab with "in 5 days 3 hours"

Step 6:  Cloudflare Cron fires every minute
         → At June 20, 10:00 AM → query returns this reminder
         → Worker fetches chat_id from users/mayank
         → sendMessage called on Telegram API
         → On success: reminder updated is_sent=true, sent_at=now()
         → Reminder moves to Sent tab

Step 7:  24 hours later → cron cleanup pass
         → reminder updated is_deleted=true
         → No longer visible in any tab

Step 8 (if recurring):
         → New reminder document created with next remind_at date
         → Cycle repeats indefinitely until user deletes it
```

---

## 13. Data Lifecycle

```
[Created] → is_sent:false, is_deleted:false
    │
    ▼ (remind_at reached + cron fires)
[Sent] → is_sent:true, sent_at:filled, is_deleted:false
    │                │
    │                └──(if recurring)── new document created → [Created]
    │
    ▼ (24 hours after sent_at)
[Archived] → is_deleted:true → excluded from all queries forever

[User deletes manually] → is_deleted:true immediately (any stage)
```

---

## 14. Error Handling Matrix

| Scenario | Expected Behavior |
|---|---|
| Username not in Firebase | Return `connected: false`, show bot link on website |
| User is_active = false | Return `connected: false, reason: inactive`, show reconnect message |
| Telegram API fails on send | Do NOT set is_sent=true, retry on next cron cycle (1 min) |
| remind_at is in the past (form submit) | Reject with "Please choose a future date and time" inline error |
| User sends /stop to bot | Set is_active=false in Firebase, website shows inactive state |
| Firebase is down | Worker returns 503, website shows "Service temporarily unavailable" toast |
| User has no Telegram username | Bot replies "Please set a public username in Settings" |
| Invalid recurrence value | Worker returns 400 "Invalid recurrence type" |
| Delete request with wrong username | Worker returns 403 "You can only delete your own reminders" |
| Empty title on form | Frontend inline validation, do not call Worker |
| Worker called with no username param | Return 400 "username is required" |

---

## 15. WHERE TO HOST EACH FILE — Noob Guide

This section explains exactly where each generated file goes, step by step, written for someone who has never deployed code before.

---

### FILE 1: `website/index.html` → Host on GitHub Pages

**What it is:** The website users visit to set reminders. One HTML file, no backend needed.

**Steps:**

```
Step 1: Create a free account at github.com

Step 2: Click the green "New" button to create a new repository
        → Repository name: teleremind  (or any name)
        → Set to Public
        → Click "Create repository"

Step 3: On your computer, open the repository page
        → Click "Add file" → "Upload files"
        → Drag and drop index.html into the box
        → Click "Commit changes"

Step 4: Go to repository Settings → Pages (left sidebar)
        → Under "Source" select: Deploy from a branch
        → Branch: main, Folder: / (root)
        → Click Save

Step 5: Wait 1-2 minutes. Your site will be live at:
        https://YOUR-GITHUB-USERNAME.github.io/teleremind

Step 6: Copy this URL — you will need it later for the Worker setup.
```

**Cost: Free forever**

---

### FILE 2: `worker/` folder → Host on Cloudflare Workers

**What it is:** The backend. Handles all API calls from the website AND receives Telegram bot messages AND runs the every-minute reminder cron job.

**Steps:**

```
Step 1: Create a free account at cloudflare.com

Step 2: Install Node.js on your computer
        → Download from nodejs.org → install with default settings

Step 3: Open Terminal (Mac/Linux) or Command Prompt (Windows)
        → Type: npm install -g wrangler
        → Press Enter and wait

Step 4: Login to Cloudflare from terminal:
        → Type: wrangler login
        → A browser window will open → click Allow

Step 5: Navigate to your worker folder in terminal:
        → Type: cd path/to/worker

Step 6: Set your secret environment variables one by one:
        → wrangler secret put TELEGRAM_BOT_TOKEN
           (paste your bot token when asked)
        → wrangler secret put FIREBASE_PROJECT_ID
           (paste your Firebase project ID when asked)
        → wrangler secret put FIREBASE_CLIENT_EMAIL
           (paste from Firebase service account JSON)
        → wrangler secret put FIREBASE_PRIVATE_KEY
           (paste the private key from service account JSON)
        → wrangler secret put WEBSITE_URL
           (paste your GitHub Pages URL from above)

Step 7: Deploy the worker:
        → Type: wrangler deploy
        → Wait for success message

Step 8: Your worker is live at:
        https://teleremind-worker.YOUR-ACCOUNT.workers.dev

Step 9: Copy this URL — you need it for 2 things:
        a) Put it in the website's index.html as the WORKER_URL variable
        b) Set the Telegram webhook (next step)

Step 10: Set the Telegram webhook — paste this URL in your browser:
         https://api.telegram.org/bot{YOUR_BOT_TOKEN}/setWebhook?url=https://teleremind-worker.YOUR-ACCOUNT.workers.dev/webhook

         You should see: {"ok":true,"result":true}
         This means Telegram will now send all bot messages to your Worker.
```

**Cost: Free up to 100,000 requests/day (more than enough)**

---

### FILE 3: Firebase Setup → Firebase Console (no file to upload)

**What it is:** The database that stores all users and reminders. No code file to deploy — you configure it in the browser.

**Steps:**

```
Step 1: Go to console.firebase.google.com
        → Sign in with your Google account

Step 2: Click "Add project"
        → Give it a name: teleremind
        → Disable Google Analytics (not needed)
        → Click "Create project"

Step 3: In the left sidebar click "Firestore Database"
        → Click "Create database"
        → Choose "Start in production mode"
        → Pick any location (choose closest to you)
        → Click "Done"

Step 4: Create the security rules
        → Click the "Rules" tab in Firestore
        → Replace all the text with the rules from Section 4
        → Click "Publish"

Step 5: Create a Service Account (so the Worker can access Firebase)
        → Click the gear icon ⚙ near "Project Overview"
        → Click "Project settings"
        → Click the "Service accounts" tab
        → Click "Generate new private key"
        → Click "Generate key"
        → A JSON file will download to your computer

Step 6: Open that JSON file in Notepad/TextEdit
        → Find "project_id" value → this is your FIREBASE_PROJECT_ID
        → Find "client_email" value → this is your FIREBASE_CLIENT_EMAIL
        → Find "private_key" value → this is your FIREBASE_PRIVATE_KEY
        → Use these 3 values when running the wrangler secret put commands above

Step 7: Create Firestore indexes
        → In Firestore, click the "Indexes" tab
        → Click "Add index"
        → Collection: reminders
          Fields: username (Ascending), is_deleted (Ascending), remind_at (Ascending)
        → Click "Create"
        → Repeat for: is_sent (Ascending), is_deleted (Ascending), remind_at (Ascending)
        → Wait a few minutes for indexes to build
```

**Cost: Free Spark plan — 1GB storage, 50,000 reads/day, 20,000 writes/day**

---

### FINAL CHECKLIST — Everything Working

```
[ ] GitHub Pages URL is live and index.html loads
[ ] Cloudflare Worker is deployed and accessible
[ ] WORKER_URL in index.html updated to your workers.dev URL
[ ] All 5 Wrangler secrets set (TOKEN, PROJECT_ID, CLIENT_EMAIL, PRIVATE_KEY, WEBSITE_URL)
[ ] Telegram webhook is set (got {"ok":true} in browser)
[ ] Firebase Firestore database created
[ ] Firebase security rules published
[ ] Firebase service account JSON downloaded
[ ] Both Firestore composite indexes created and built
[ ] Test: Open your Telegram bot → send /start → got welcome message
[ ] Test: Visit your GitHub Pages website → enter username → see Connected badge
[ ] Test: Add a reminder 2 minutes in future → wait → receive Telegram message
```

---

### Summary Table

| What | File | Host On | How |
|---|---|---|---|
| Website | `website/index.html` | GitHub Pages | Upload to GitHub repo, enable Pages in Settings |
| Backend + Bot + Cron | `worker/*.js` + `wrangler.toml` | Cloudflare Workers | `wrangler deploy` from terminal |
| Database | (no file — browser setup) | Firebase Firestore | Firebase Console, create project + Firestore |
| Bot Webhook | (no file — one browser URL) | Set via Telegram API | Paste webhook URL in browser once |

---

## 16. Free Tier Limits Reference

| Service | Free Tier | Daily Usage Estimate |
|---|---|---|
| Cloudflare Workers | 100,000 requests/day | ~200 users × 50 actions |
| Cloudflare Cron | Included free | 1440 cron runs/day (every minute) |
| Firebase Firestore reads | 50,000/day | Each page load = ~5 reads |
| Firebase Firestore writes | 20,000/day | Each reminder = 1 write |
| Firebase storage | 1 GB | Years of reminder data |
| Telegram Bot API | Unlimited | No limit |
| GitHub Pages | Unlimited | No limit |
| **Total Cost** | **₹0 / $0** | |

---

*End of PRD v2.0 — TeleRemind*

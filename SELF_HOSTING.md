# Self-hosting Steady for free (personal use)

Every feature stays on: email/password and Google sign-in, email verification, accountability
invitations and missed-day emails to your partner, voice-to-task, reminders, focus, leaderboards
and `/admin`. Everything runs on free tiers. You don't need a card or a domain.

| Piece | Service | Notes |
| --- | --- | --- |
| Database | **Turso** (your existing DB) | Nothing to migrate. |
| Backend | **Render** free web service (Docker) | You get an HTTPS URL. It sleeps after 15 idle minutes, so the pinger below keeps it awake. |
| Keep-alive + missed-day alerts | **cron-job.org** (free) | Calls `/api/cron/tick` every 5 minutes. That keeps Render awake and runs the missed-day sweep on a schedule. |
| Google sign-in | **Google Cloud** OAuth client (free) | Replaces Runable's managed Google login. Existing Google users are matched by email, so their data stays. |
| Email (verification, partner invites, missed-day alerts) | **Your Gmail via Google Apps Script** (free) | Render's free tier blocks SMTP, so mail goes over HTTPS through a small script in your own Gmail. Limit is about 100 recipients a day. |
| Voice-to-task | **Gemini API key** (Google AI Studio free tier) | On the free tier, Google may use prompts to improve its products. |
| APK | **GitHub Actions** | Builds a signed release APK and attaches it to a GitHub Release. |

## 1. Google sign-in (about 5 minutes)

1. Go to https://console.cloud.google.com and create a project named "Steady".
2. Open **APIs & Services → OAuth consent screen** (on newer consoles: **Google Auth Platform → Branding/Audience**).
   - User type: **External**. App name: Steady. Fill in your email.
   - Under **Audience → Test users**, add every Google account that will sign in. You can also click **Publish app**: the `email`/`profile` scopes don't need Google's review.
3. Open **Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**.
   - Authorized redirect URI: `https://<your-render-url>/api/auth/callback/google`
4. Copy the **Client ID** and **Client secret**. They become `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

## 2. Gmail relay for email (about 5 minutes)

1. Sign in as the Gmail account that should send Steady mail and open https://script.google.com. Click **New project**.
2. Paste the contents of [`deploy/gmail-relay.gs`](deploy/gmail-relay.gs) over `Code.gs` and save.
3. Open **Project Settings → Script properties → Add**. Set `RELAY_SECRET` to the same value as `GMAIL_RELAY_SECRET` on Render. Render generates that value; copy it from the service's Environment tab.
4. Click **Deploy → New deployment → Web app**. Set Execute as: **Me** and Who has access: **Anyone**. Authorize it. On the "unverified app" screen, choose Advanced → Go to project.
5. Copy the Web app URL (it ends in `/exec`). It becomes `GMAIL_RELAY_URL`.

If you'd rather use a provider: `EMAIL_PROVIDER=resend` still works with a verified domain. `GMAIL_TRANSPORT=smtp` with `GMAIL_APP_PASSWORD` works on any host that allows SMTP.

## 3. Gemini key

Create a key at https://aistudio.google.com/apikey. It becomes `GEMINI_API_KEY`. The default model is `gemini-3-flash-preview`, and you can change it with `GEMINI_MODEL`.

## 4. Render backend

1. Sign up at https://render.com with GitHub and allow access to this repo.
2. Go to **New → Blueprint** and pick this repo. Render reads [`render.yaml`](render.yaml).
3. Fill in the values it asks for:

| Key | Value |
| --- | --- |
| `WEBSITE_URL` | `https://steady-api.onrender.com`. Use your real URL, which is shown after the first deploy. Update it if it differs. |
| `BETTER_AUTH_SECRET` | Your **existing** value if you have it (Runable project `.env`). Otherwise use `openssl rand -base64 32`. A new value logs everyone out and makes old pending invitation payloads unreadable. They fail closed, and users just re-invite. |
| `DATABASE_URL`, `DATABASE_AUTH_TOKEN` | From Turso (`turso db show <db> --url`, `turso db tokens create <db>`) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | From step 1 |
| `GEMINI_API_KEY` | From step 3 |
| `GMAIL_USER` | `you@gmail.com`, the same account that owns the Apps Script |
| `EMAIL_FROM` | `Steady <you@gmail.com>` |
| `GMAIL_RELAY_URL` | From step 2 |
| `INVITATION_APP_URL` | `https://<your-render-url>/invitation` |
| `MISS_ALERTS_START_DATE` | Tomorrow's date, `YYYY-MM-DD` |
| `ADMIN_KEY` | Optional. A long random string enables `/admin`. |

4. After it deploys, open `https://<your-render-url>/api/health`. It should return `{"status":"ok"}`.
5. If the URL isn't `steady-api.onrender.com`, update `WEBSITE_URL`, `INVITATION_APP_URL` and the Google redirect URI.

## 5. Keep-alive and missed-day sweep

At https://cron-job.org (free), create a job:
- URL: `https://<your-render-url>/api/cron/tick?key=<CRON_SECRET>`. Copy `CRON_SECRET` from Render's Environment tab.
- Schedule: every 5 minutes.

It should return `{"ok":true,...}`. One always-on service uses about 744 hours a month, which fits inside Render's 750 free hours.

## 6. Build the APK

1. In the GitHub repo, go to **Settings → Secrets and variables → Actions**.
   - **Variables** tab: add `STEADY_API_URL` = `https://<your-render-url>`.
   - **Secrets** tab: add `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_PASSWORD` and `ANDROID_KEY_ALIAS` from your signing backup. Back up the keystore permanently. Without the same key, a new APK can't install over the old one.
2. Go to **Actions → Android APK → Run workflow**. It takes about 20–30 minutes.
3. On your phone, open the repo's **Releases** page, download the newest `steady-*.apk` and allow "Install unknown apps" for the browser.

Each push to `main` that touches the app rebuilds it.

## Limits to know

- After a cold start (if the pinger ever stops), the first request takes about 1 minute.
- The Gmail relay allows about 100 recipients a day, and invitations come from your Gmail address.
- Invitation links sent from the old Runable deployment point at the old domain. Re-send invitations from the new app.
- This repository is public, so anyone can download the Releases. They'd need your server to do anything, and new sign-ups are open. Make the repo private if you want; Actions still gets 2,000 free minutes a month.

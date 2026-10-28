/**
 * Steady Gmail relay — free HTTPS email sending from your own Gmail account.
 *
 * Why: Render's free tier blocks outbound SMTP (ports 25/465/587), so the backend can't talk to
 * smtp.gmail.com. This tiny Google Apps Script runs inside your Gmail account and sends the mail
 * for the backend over HTTPS. Free; consumer Gmail allows ~100 recipients/day via Apps Script.
 *
 * Setup (once):
 *  1. Signed in as the Gmail account that should send Steady mail, open https://script.google.com
 *     -> New project. Replace Code.gs with this file. Save.
 *  2. Project Settings (gear) -> Script properties -> Add property:
 *       RELAY_SECRET = <the same long random value you put in GMAIL_RELAY_SECRET on Render>
 *  3. Deploy -> New deployment -> type "Web app".
 *       Execute as: Me      Who has access: Anyone
 *     Authorize when asked ("Google hasn't verified this app" -> Advanced -> Go to project).
 *  4. Copy the Web app URL (ends in /exec) into GMAIL_RELAY_URL on Render.
 *  If you edit this script later: Deploy -> Manage deployments -> edit -> Version: New version.
 */
function doPost(e) {
  var secret = PropertiesService.getScriptProperties().getProperty("RELAY_SECRET");
  var body;
  try { body = JSON.parse(e.postData.contents); } catch (err) { return reply({ ok: false, code: "bad_request" }); }
  if (!secret || !body || body.secret !== secret) return reply({ ok: false, code: "unauthorized" });

  var to = String(body.to || "");
  if (!/^[^\s<>(),;@]+@[^\s<>(),;@]+\.[^\s<>(),;@]+$/.test(to)) return reply({ ok: false, code: "recipient_invalid" });
  if (MailApp.getRemainingDailyQuota() < 1) return reply({ ok: false, code: "quota_exhausted" });

  try {
    MailApp.sendEmail({
      to: to,
      subject: String(body.subject || "").slice(0, 250),
      body: String(body.text || ""),
      htmlBody: body.html ? String(body.html) : undefined,
      name: "Steady",
    });
  } catch (err) {
    return reply({ ok: false, code: "send_failed" });
  }
  return reply({ ok: true, id: Utilities.getUuid(), sender: Session.getEffectiveUser().getEmail() });
}

function doGet() {
  return reply({ ok: true, service: "steady-gmail-relay" });
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

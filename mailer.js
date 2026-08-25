// Sends notification email to the site owner — password-reset requests
// and player feedback both relay here rather than going anywhere else,
// since there's no self-service reset flow yet (see MULTIPLAYER_PLAN.md
// for the broader auth design). Reads generic SMTP settings from env
// vars so whatever host/email provider gets chosen later is just a
// config change, not a code change. Falls back to logging the message
// to the console when SMTP isn't configured, so the feature is fully
// testable before any provider exists.

const nodemailer = require('nodemailer');

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, OWNER_EMAIL } = process.env;

const configured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && OWNER_EMAIL);

const transporter = configured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT) || 587,
      secure: Number(SMTP_PORT) === 465,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

async function sendOwnerEmail({ subject, text }) {
  if (!configured) {
    console.log(`[mailer] SMTP not configured — would send:\nSubject: ${subject}\n${text}\n`);
    return;
  }
  await transporter.sendMail({ from: SMTP_FROM || SMTP_USER, to: OWNER_EMAIL, subject, text });
}

module.exports = { sendOwnerEmail };

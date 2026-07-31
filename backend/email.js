const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'onboarding@resend.dev';
const APP_URL = process.env.APP_URL || (process.env.NODE_ENV === 'production' ? '' : 'http://localhost:5173');
const APP_NAME = 'Poker Club';

let resend = null;

/**
 * Initialize the Resend client. Called lazily — only when an email is sent.
 * This way the app doesn't crash at startup if RESEND_API_KEY is not set.
 */
function getClient() {
  if (!resend) {
    if (!RESEND_API_KEY) {
      console.warn('[Email] RESEND_API_KEY not set — emails will not be sent.');
      return null;
    }
    resend = new Resend(RESEND_API_KEY);
  }
  return resend;
}

/**
 * Send a welcome email after registration.
 * @param {string} to - Recipient email
 * @param {string} displayName - User's display name
 */
async function sendWelcomeEmail(to, displayName) {
  const client = getClient();
  if (!client) return false;

  try {
    await client.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `Welcome to ${APP_NAME}!`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f0f0f; margin: 0; padding: 0; }
            .container { max-width: 480px; margin: 0 auto; padding: 32px 24px; }
            .header { text-align: center; margin-bottom: 24px; }
            .logo { font-size: 48px; margin-bottom: 8px; }
            h1 { color: #ffffff; font-size: 24px; margin: 0; }
            .card { background: #1a1a2e; border-radius: 16px; padding: 32px 24px; border: 1px solid #2a2a4a; }
            .card h2 { color: #fbbf24; font-size: 20px; margin: 0 0 12px 0; }
            .card p { color: #b0b0c0; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
            .btn { display: inline-block; background: linear-gradient(135deg, #059669, #10b981); color: #fff; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: bold; font-size: 14px; }
            .footer { text-align: center; margin-top: 24px; color: #666; font-size: 12px; }
            .stats { display: flex; gap: 16px; justify-content: center; margin: 20px 0; }
            .stat { background: #0f0f1f; border-radius: 12px; padding: 12px 20px; text-align: center; }
            .stat-value { color: #fbbf24; font-size: 20px; font-weight: bold; display: block; }
            .stat-label { color: #888; font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="logo">🃏</div>
              <h1>Welcome to ${APP_NAME}</h1>
            </div>
            <div class="card">
              <h2>Hey ${displayName}! 👋</h2>
              <p>Your account is ready. You've been gifted <strong>10,000 chips</strong> to start your poker journey. Choose your stakes and join a table!</p>
              <div class="stats">
                <div class="stat">
                  <span class="stat-value">10,000</span>
                  <span class="stat-label">Starting Chips</span>
                </div>
                <div class="stat">
                  <span class="stat-value">6</span>
                  <span class="stat-label">Stake Levels</span>
                </div>
              </div>
              <div style="text-align: center;">
                <a href="${APP_URL}" class="btn">🚀 Play Now</a>
              </div>
            </div>
            <div class="footer">
              <p>${APP_NAME} — Private tables for you and your friends.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    console.log(`[Email] Welcome email sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send welcome email to ${to}:`, err.message);
    return false;
  }
}

/**
 * Send a password reset email with a reset link.
 * @param {string} to - Recipient email
 * @param {string} resetToken - The reset token (URL-safe)
 */
async function sendPasswordResetEmail(to, resetToken) {
  const client = getClient();
  if (!client) return false;

  const resetUrl = `${APP_URL}/reset-password?token=${resetToken}`;

  try {
    await client.emails.send({
      from: FROM_EMAIL,
      to,
      subject: `Reset your ${APP_NAME} password`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <style>
            body { font-family: 'Segoe UI', Arial, sans-serif; background: #0f0f0f; margin: 0; padding: 0; }
            .container { max-width: 480px; margin: 0 auto; padding: 32px 24px; }
            .header { text-align: center; margin-bottom: 24px; }
            .logo { font-size: 48px; margin-bottom: 8px; }
            h1 { color: #ffffff; font-size: 24px; margin: 0; }
            .card { background: #1a1a2e; border-radius: 16px; padding: 32px 24px; border: 1px solid #2a2a4a; }
            .card h2 { color: #fbbf24; font-size: 20px; margin: 0 0 12px 0; }
            .card p { color: #b0b0c0; font-size: 14px; line-height: 1.6; margin: 0 0 20px 0; }
            .btn { display: inline-block; background: linear-gradient(135deg, #f59e0b, #fbbf24); color: #000; text-decoration: none; padding: 14px 32px; border-radius: 12px; font-weight: bold; font-size: 14px; }
            .footer { text-align: center; margin-top: 24px; color: #666; font-size: 12px; }
            .warning { background: #2a1a0f; border: 1px solid #4a2a1f; border-radius: 8px; padding: 12px; color: #fbbf24; font-size: 12px; margin-top: 16px; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="logo">🔐</div>
              <h1>Password Reset</h1>
            </div>
            <div class="card">
              <h2>Reset your password</h2>
              <p>Someone requested a password reset for your ${APP_NAME} account. If this was you, click the button below to set a new password.</p>
              <div style="text-align: center;">
                <a href="${resetUrl}" class="btn">Reset Password</a>
              </div>
              <div class="warning">
                ⚠️ This link expires in 1 hour. If you didn't request this, you can safely ignore this email.
              </div>
            </div>
            <div class="footer">
              <p>${APP_NAME} — Private tables for you and your friends.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });
    console.log(`[Email] Password reset email sent to ${to}`);
    return true;
  } catch (err) {
    console.error(`[Email] Failed to send password reset email to ${to}:`, err.message);
    return false;
  }
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail };
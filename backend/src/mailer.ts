import nodemailer from 'nodemailer';

const enabled = (process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';

// Check if using Resend (HTTP API) or traditional SMTP
const useResend = !!process.env.RESEND_API_KEY;

// SMTP transport (fallback)
const transporter = (enabled && !useResend) ? nodemailer.createTransport({
  host: process.env.SMTP_HOST!,
  port: Number(process.env.SMTP_PORT || 587),
  secure: (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER!,
    pass: process.env.SMTP_PASS!,
  },
}) : null;

const fromName = process.env.EMAIL_FROM_NAME || 'Pro Scalp Scanner';
const fromAddr = process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER || 'no-reply@localhost';

export type MailPayload = {
  to: string | string[];
  subject: string;
  html: string;
  text?: string;
};

// Resend API sender
async function sendViaResend(payload: MailPayload): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    const apiKey = process.env.RESEND_API_KEY!;
    const to = Array.isArray(payload.to) ? payload.to : [payload.to];
    
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: `${fromName} <${fromAddr}>`,
        to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('[email] Resend API error:', error);
      return { ok: false, error };
    }

    const data = await response.json();
    return { ok: true, messageId: data.id };
  } catch (error: any) {
    console.error('[email] Resend fetch error:', error.message);
    return { ok: false, error: error.message };
  }
}

// SMTP sender
async function sendViaSmtp(payload: MailPayload): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  try {
    if (!transporter) {
      return { ok: false, error: 'NO_TRANSPORT' };
    }

    const to = Array.isArray(payload.to) ? payload.to.join(',') : payload.to;
    const info = await transporter.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
    return { ok: true, messageId: info.messageId };
  } catch (error: any) {
    console.error('[email] SMTP error:', error.message);
    return { ok: false, error: error.message };
  }
}

export async function sendMail(payload: MailPayload) {
  if (!enabled) return { ok: false, reason: 'EMAIL_DISABLED' };

  console.log('[email] Sending via', useResend ? 'Resend API' : 'SMTP');
  
  if (useResend) {
    return sendViaResend(payload);
  } else {
    return sendViaSmtp(payload);
  }
}

export function isEmailEnabled() {
  return enabled;
}

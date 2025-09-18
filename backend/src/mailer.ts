import nodemailer from 'nodemailer';

const enabled = (process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';

const transporter = enabled ? nodemailer.createTransport({
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

export async function sendMail(payload: MailPayload) {
  if (!enabled) return { ok: false, reason: 'EMAIL_DISABLED' };
  if (!transporter) return { ok: false, reason: 'NO_TRANSPORT' };

  const to = Array.isArray(payload.to) ? payload.to.join(',') : payload.to;
  const info = await transporter.sendMail({
    from: `"${fromName}" <${fromAddr}>`,
    to,
    subject: payload.subject,
    text: payload.text,
    html: payload.html,
  });
  return { ok: true, messageId: info.messageId };
}

export function isEmailEnabled() {
  return enabled;
}

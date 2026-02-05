import nodemailer from 'nodemailer';

type MailPayload = {
  to: string | string[];
  subject: string;
  text?: string;
  html?: string;
};

const enabled = (process.env.EMAIL_ENABLED || 'false').toLowerCase() === 'true';

const fromName = process.env.EMAIL_FROM_NAME || 'Pro Scalp Scanner';
const fromAddr = process.env.EMAIL_FROM_ADDRESS || process.env.SMTP_USER || 'no-reply@localhost';

let transporter: nodemailer.Transporter | null = null;

function getTransporter() {
  if (!enabled) return null;
  if (transporter) return transporter;

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = (process.env.SMTP_SECURE || 'false').toLowerCase() === 'true';
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !user || !pass) {
    console.warn('[email] Missing SMTP config. Set SMTP_HOST/SMTP_USER/SMTP_PASS (+ SMTP_PORT/SMTP_SECURE).');
    return null;
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: { user, pass },
    tls: { minVersion: 'TLSv1.2' },
  });

  return transporter;
}

export async function sendMail(payload: MailPayload) {
  if (!enabled) return { ok: false as const, reason: 'EMAIL_DISABLED' };
  const t = getTransporter();
  if (!t) return { ok: false as const, reason: 'NO_TRANSPORT' };

  const to = Array.isArray(payload.to) ? payload.to.join(',') : payload.to;

  try {
    const info = await t.sendMail({
      from: `"${fromName}" <${fromAddr}>`,
      to,
      subject: payload.subject,
      text: payload.text,
      html: payload.html,
    });
    return { ok: true as const, messageId: info.messageId };
  } catch (e: any) {
    const code = e?.code;
    const resp = String(e?.response || '');

    // Helpful Gmail hint
    if (code === 'EAUTH' && resp.includes('5.7.8')) {
      console.error(
        '[email] Gmail rejected credentials (535 5.7.8). ' +
          'Use a Google App Password (requires 2-Step Verification). Normal Gmail password usually fails.'
      );
    }

    console.error('[email] sendMail error', e);
    return { ok: false as const, reason: code || 'SEND_FAILED' };
  }
}

export function isEmailEnabled() {
  return enabled;
}

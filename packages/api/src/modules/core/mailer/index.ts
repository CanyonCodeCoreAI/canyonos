import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import { config } from '@core/env';
import { LOG_DOMAINS, logger } from '@core/logger';

const mailLogger = logger.child({ domain: LOG_DOMAINS.MAIL });

let _transport: Transporter | null = null;

function getTransport(): Transporter {
  if (_transport) return _transport;
  const email = config.email;
  if (!email.enabled) throw new Error('Email is disabled; no SMTP transport is configured');
  _transport = nodemailer.createTransport({
    host: email.smtpHost,
    port: email.smtpPort,
    secure: email.secure,
    auth: email.smtpUsername ? { user: email.smtpUsername, pass: email.smtpPassword } : undefined,
  });
  return _transport;
}

export interface SendArgs {
  from: string;
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export async function sendEmail(args: SendArgs): Promise<{ ok: boolean }> {
  try {
    await getTransport().sendMail(args);
    mailLogger.info('Email sent', { to: args.to, subject: args.subject });
    return { ok: true };
  } catch (error) {
    mailLogger.error('Email send failed', { error, to: args.to });
    return { ok: false };
  }
}

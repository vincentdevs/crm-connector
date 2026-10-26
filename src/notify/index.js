// The notification email to the people who handle leads. It is sent after the CRM pushes, so it
// can say where the lead landed, and Reply-To is the visitor, so answering the email answers them.
import { request, DeliveryError } from '../http.js';
import { displayName, lines, oneLine } from '../lead.js';
import { buildMessage, sendSmtp } from './smtp.js';

export function compose(lead, notify, crmResults, submissionId) {
  const subject = oneLine((notify.subject || 'New {form_title} from {name}')
    .replace('{name}', displayName(lead))
    .replace(/\{(\w+)\}/g, (_, k) => lead[k] ?? ''), 200);
  const crm = crmResults.length
    ? crmResults.map((r) => `${r.target}: ${r.status === 'done' ? `${r.action}, ${r.ref}` : `not yet, ${r.permanent ? 'rejected by the CRM and needs a person' : 'will retry'} (${r.error})`}`)
    : ['No CRM is configured for this form.'];
  const text = [
    `${displayName(lead)} filled in "${lead.form_title}".`,
    '',
    ...lines(lead),
    '',
    'CRM',
    ...crm,
    '',
    `Submission ${submissionId}. Reply to this email to answer ${lead.email} directly.`,
  ].join('\n');
  return { subject, text };
}

export async function send(notify, { subject, text, replyTo, messageId }, rt) {
  const to = [].concat(notify.to);
  switch (notify.transport) {
    case 'smtp': {
      const data = buildMessage({ from: notify.from, fromName: notify.fromName, to, replyTo, subject, text, messageId });
      try {
        await sendSmtp(rt.openSocket, notify.smtp, { from: notify.from, to, data });
      } catch (err) {
        // 5xx replies other than auth mean the server refused this message for good
        throw new DeliveryError(err.message, { permanent: / -> 5(?!35)\d\d/.test(err.message) && !/AUTH/.test(err.message) });
      }
      return `smtp ${notify.smtp.host}`;
    }
    case 'resend': {
      const r = await request(rt, 'POST', 'https://api.resend.com/emails', {
        headers: { authorization: `Bearer ${notify.apiKey}`, 'idempotency-key': messageId },
        json: { from: notify.fromName ? `${notify.fromName} <${notify.from}>` : notify.from, to, subject, text, reply_to: replyTo },
      });
      return `resend ${r?.id || ''}`.trim();
    }
    case 'postmark': {
      const r = await request(rt, 'POST', 'https://api.postmarkapp.com/email', {
        headers: { 'x-postmark-server-token': notify.apiKey },
        json: { From: notify.fromName ? `${notify.fromName} <${notify.from}>` : notify.from, To: to.join(','), Subject: subject, TextBody: text, ReplyTo: replyTo, MessageStream: notify.stream || 'outbound' },
      });
      return `postmark ${r?.MessageID || ''}`.trim();
    }
    case 'log':
      rt.log?.(`[notify] to ${to.join(', ')}: ${subject}\n${text}`);
      return 'log';
    default:
      throw new DeliveryError(`notify: unknown transport "${notify.transport}"`, { permanent: true });
  }
}

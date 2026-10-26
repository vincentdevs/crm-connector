// A small SMTP client that runs on Node and on Cloudflare Workers. The runtime hands in
// openSocket(), which returns { read(): Promise<Uint8Array|null>, write(bytes), startTls(), close() },
// so the protocol code below is the same on both. Port 465 is implicit TLS, 587 is STARTTLS.

const enc = new TextEncoder();

export function b64(text) {
  const bytes = typeof text === 'string' ? enc.encode(text) : text;
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function encodeHeader(text) {
  return /^[\x20-\x7e]*$/.test(text) ? text : `=?UTF-8?B?${b64(text)}?=`;
}

function encodeName(name, addr) {
  if (!name) return `<${addr}>`;
  return /^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}" <${addr}>` : `=?UTF-8?B?${b64(name)}?= <${addr}>`;
}

// Builds an RFC 5322 message. Header values are already single-line (lead.oneLine), and the
// check below refuses any CR or LF that slipped through, because that is header injection.
export function buildMessage({ from, fromName, to, replyTo, subject, text, messageId, date = new Date() }) {
  for (const v of [from, fromName, replyTo, subject, ...to]) {
    if (v && /[\r\n]/.test(v)) throw new Error('smtp: refusing a header value with a line break');
  }
  const headers = [
    `From: ${encodeName(fromName, from)}`,
    `To: ${to.map((a) => `<${a}>`).join(', ')}`,
    replyTo ? `Reply-To: <${replyTo}>` : null,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
  ].filter(Boolean);
  const body = b64(text.replace(/\r?\n/g, '\r\n')).match(/.{1,76}/g).join('\r\n');
  return headers.join('\r\n') + '\r\n\r\n' + body;
}

export async function sendSmtp(openSocket, cfg, { from, to, data }) {
  const port = Number(cfg.port || 465);
  const mode = cfg.tls || (port === 465 ? 'implicit' : port === 587 ? 'starttls' : 'off');
  let sock = await openSocket({ host: cfg.host, port, tls: mode });
  const dec = new TextDecoder();
  let buf = '';

  const read = async () => {
    for (;;) {
      const parts = buf.split('\r\n');
      for (let i = 0; i < parts.length - 1; i++) {
        if (/^\d{3} /.test(parts[i])) {
          const text = parts.slice(0, i + 1).join('\n');
          buf = parts.slice(i + 1).join('\r\n');
          return { code: Number(parts[i].slice(0, 3)), text };
        }
      }
      const chunk = await sock.read();
      if (chunk === null) throw new Error('smtp: connection closed');
      buf += dec.decode(chunk, { stream: true });
    }
  };
  const cmd = async (line, ok) => {
    if (line !== null) await sock.write(enc.encode(line + '\r\n'));
    const r = await read();
    if (!ok.includes(r.code)) throw new Error(`smtp: ${line === null ? 'greeting' : line.split(' ')[0]} -> ${r.text.slice(0, 200)}`);
    return r;
  };

  const helo = cfg.helo || from.split('@')[1] || 'localhost';
  const session = (async () => {
    await cmd(null, [220]);
    await cmd(`EHLO ${helo}`, [250]);
    if (mode === 'starttls') {
      await cmd('STARTTLS', [220]);
      sock = await sock.startTls();
      buf = '';
      await cmd(`EHLO ${helo}`, [250]);
    }
    if (cfg.user && cfg.pass) await cmd(`AUTH PLAIN ${b64('\0' + cfg.user + '\0' + cfg.pass)}`, [235]);
    await cmd(`MAIL FROM:<${from}>`, [250]);
    for (const rcpt of to) await cmd(`RCPT TO:<${rcpt}>`, [250, 251]);
    await cmd('DATA', [354]);
    // Dot-stuffing: a line that starts with "." gets a second one, so it cannot end the message early
    await cmd(data.replace(/\r\n\./g, '\r\n..') + '\r\n.', [250]);
    await sock.write(enc.encode('QUIT\r\n')).catch(() => {});
  })();
  let timer;
  const timeout = new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('smtp: timed out after 20s')), 20000); });
  try {
    await Promise.race([session, timeout]);
  } finally {
    clearTimeout(timer);
    try { await sock.close(); } catch {}
  }
}

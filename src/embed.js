// The browser snippet served at /embed.js. Add data-crm-connector to any <form> whose action points at
// the relay, and it posts as JSON, stays on the page and shows the result. Without JavaScript the
// same form still works as a plain POST, which the relay answers with a redirect.
export const EMBED = `(() => {
  const q = (f, s) => f.querySelector(s);
  const hidden = (f, name, value) => {
    let i = q(f, 'input[name="' + name + '"]');
    if (!i) { i = document.createElement('input'); i.type = 'hidden'; i.name = name; f.appendChild(i); }
    i.value = value;
  };
  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
  const setup = (f) => {
    if (f.dataset.relayReady) return;
    f.dataset.relayReady = '1';
    hidden(f, '_id', uid());
    hidden(f, '_t', String(Date.now()));
    if (!q(f, 'input[name="_gotcha"]')) {
      const w = document.createElement('div');
      w.setAttribute('aria-hidden', 'true');
      w.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;overflow:hidden';
      w.innerHTML = '<label>Leave this empty<input name="_gotcha" tabindex="-1" autocomplete="off"></label>';
      f.appendChild(w);
    }
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = q(f, '[type="submit"]');
      const err = q(f, '[data-relay-error]');
      if (err) { err.textContent = ''; err.hidden = true; }
      if (btn) btn.disabled = true;
      const data = {};
      new FormData(f).forEach((v, k) => { if (typeof v === 'string') data[k] = data[k] ? data[k] + ', ' + v : v; });
      for (const p of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
        const v = new URLSearchParams(location.search).get(p);
        if (v && !data[p]) data[p] = v;
      }
      data.page_url = data.page_url || location.href.split('#')[0];
      if (document.referrer && !data.referrer) data.referrer = document.referrer;
      try {
        const res = await fetch(f.action, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(data) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || !body.ok) throw new Error(body.message || 'The form could not be sent. Please try again.');
        f.dispatchEvent(new CustomEvent('crm-connector:sent', { detail: body, bubbles: true }));
        if (f.dataset.redirect) { location.href = f.dataset.redirect; return; }
        const done = document.createElement('p');
        done.setAttribute('role', 'status');
        done.className = 'crm-connector-success';
        done.textContent = f.dataset.success || 'Thank you, your message has been sent.';
        f.replaceWith(done);
      } catch (x) {
        let box = err;
        if (!box) { box = document.createElement('p'); box.setAttribute('data-relay-error', ''); box.setAttribute('role', 'alert'); f.appendChild(box); }
        box.textContent = x.message;
        box.hidden = false;
        // The same _id is kept, so a retry after a lost response cannot create a second lead
        if (btn) btn.disabled = false;
      }
    });
  };
  const scan = () => document.querySelectorAll('form[data-crm-connector]').forEach(setup);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', scan); else scan();
  new MutationObserver(scan).observe(document.documentElement, { childList: true, subtree: true });
})();
`;

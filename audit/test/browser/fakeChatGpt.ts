import http from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A tiny local stand-in for chatgpt.com's DOM used ONLY to verify the Playwright
 * adapter's plumbing (typing, sending, waiting for streaming to finish, reading
 * the rendered answer, screenshots, sign-in detection). It is not ChatGPT and
 * does not satisfy the live acceptance gate.
 */
const page = (opts: { signedIn: boolean; stall?: boolean; temporary: boolean }) => `<!doctype html>
<html><head><title>ChatGPT (local test double)</title></head>
<body>
<header>
  ${opts.signedIn ? '<button data-testid="profile-button">Me</button>' : '<a href="/auth/login" data-testid="login-button">Log in</a><a href="/auth/signup">Sign up for free</a>'}
  ${opts.temporary ? '<span class="badge">Temporary Chat</span>' : ''}
</header>
<main id="thread"></main>
${opts.signedIn ? `
<div id="composer">
  <div id="prompt-textarea" contenteditable="true" data-virtualkeyboard="true" style="min-height:40px;border:1px solid #ccc"></div>
  <button data-testid="send-button" aria-label="Send prompt">Send</button>
</div>
<script>
  const thread = document.getElementById('thread');
  const composer = document.getElementById('prompt-textarea');
  const send = document.querySelector('[data-testid="send-button"]');
  function article(role) { const a = document.createElement('article'); a.setAttribute('data-message-author-role', role); thread.appendChild(a); return a; }
  async function submit() {
    const prompt = composer.innerText.trim(); if (!prompt) return;
    composer.innerHTML = '';
    article('user').innerText = prompt;
    send.hidden = true;
    const stop = document.createElement('button'); stop.setAttribute('data-testid','stop-button'); stop.textContent='Stop'; document.getElementById('composer').appendChild(stop);
    const a = article('assistant'); const body = document.createElement('div'); body.className = 'markdown'; a.appendChild(body);
    const html = '<p>For <em>' + prompt.replace(/</g,'&lt;') + '</em>, here are some options:</p><ul>' +
      '<li><p><strong>Solent Roofing</strong> – long-established local firm.</p></li>' +
      '<li><p><a href="https://www.stormguardroofing.co.uk/">Stormguard Roofing</a> – flat roof specialists.</p></li>' +
      '<li><p><strong>Checkatrade</strong> – a directory of vetted trades.</p></li></ul>';
    const words = html.split(' ');
    for (let i = 1; i <= words.length; i++) { body.innerHTML = words.slice(0, i).join(' '); await new Promise(r => setTimeout(r, 40)); }
    ${opts.stall ? 'return; // never finishes: stop button stays' : ''}
    stop.remove(); send.hidden = false;
  }
  send.addEventListener('click', submit);
  composer.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
</script>` : '<p>Welcome back. Log in to continue.</p>'}
</body></html>`;

export async function startFakeChatGpt(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const temporary = url.searchParams.get('temporary-chat') === 'true';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname.startsWith('/signedout')) return res.end(page({ signedIn: false, temporary }));
    if (url.pathname.startsWith('/stall')) return res.end(page({ signedIn: true, stall: true, temporary }));
    res.end(page({ signedIn: true, temporary }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

import type { AuditRecord, Layer, LayerState } from '../domain/types.ts';
import { LAYERS } from '../domain/types.ts';
import { publicPath } from './tracking.ts';

export interface PublicReportOptions {
  token: string;
  /** Per-render session nonce; the page quotes it when reporting genuine engagement. */
  session?: string;
  ctaLabel?: string;
  /** Milliseconds of continuous visibility before the page reports engagement (default 2000). */
  engagementDelayMs?: number;
}

/**
 * First-party engagement beacon. Fires once per rendered page, only after the
 * document has been loaded AND visible for the delay without interruption.
 * Link-preview bots and scanners that merely fetch the HTML never trigger it.
 */
function engagementScript(base: string, session: string, delayMs: number): string {
  return `<script>
(function(){
  var sent=false,timer=null,url=${JSON.stringify(`${base}/engaged`)},body=JSON.stringify({session:${JSON.stringify(session)}});
  function send(){
    if(sent)return;sent=true;
    try{fetch(url,{method:'POST',headers:{'content-type':'application/json'},body:body,keepalive:true,credentials:'same-origin'}).catch(function(){});}catch(e){}
  }
  function arm(){
    if(sent||timer)return;
    if(document.visibilityState!=='visible')return;
    timer=setTimeout(function(){timer=null;if(document.visibilityState==='visible')send();},${delayMs});
  }
  function disarm(){if(timer){clearTimeout(timer);timer=null;}}
  document.addEventListener('visibilitychange',function(){if(document.visibilityState==='visible')arm();else disarm();});
  if(document.readyState==='complete')arm();else window.addEventListener('load',arm);
})();
</script>`;
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

const LAYER_COPY: Record<Layer, { title: string; question: string; yes: string; no: string }> = {
  VISIBLE: {
    title: 'Visible',
    question: 'Does ChatGPT know you exist when someone searches for your type of business locally?',
    yes: 'ChatGPT listed you when we searched for your service in your area.',
    no: 'ChatGPT did not list you when we searched for your service in your area.',
  },
  RECOMMENDED: {
    title: 'Recommended',
    question: 'When someone asks ChatGPT who it would recommend, are you one of the names it gives?',
    yes: 'ChatGPT named you when we asked who it would recommend.',
    no: 'ChatGPT recommended other businesses, not you, when we asked who it would recommend.',
  },
  CONVERSATIONAL: {
    title: 'Conversational',
    question: 'When a customer describes a real problem in conversation and asks who to speak to, do you come up?',
    yes: 'ChatGPT introduced you during a natural conversation about a real customer problem.',
    no: 'ChatGPT introduced other businesses, not you, during a natural conversation about a real customer problem.',
  },
};

function fileName(evidencePath: string): string {
  return decodeURIComponent(evidencePath.split('/').at(-1) ?? '');
}

/** Basenames of every screenshot that belongs to this audit's evidence. Anything else is not served publicly. */
export function publicEvidenceFiles(record: AuditRecord): string[] {
  const e = record.evidence;
  return [...e.visibleScreenshots, ...e.recommendedScreenshots, ...e.conversationalScreenshots].map(fileName);
}

function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(iso));
  } catch {
    return '';
  }
}

function stateWord(state: LayerState): string {
  return state === 'YES' ? 'YES' : 'NO';
}

/**
 * Prospect-facing report. Deliberately contains no internal ids, provider names,
 * classification data, file paths, errors or ChatGPT transcripts: only the
 * verdicts, the questions we asked, the competitors named and the screenshots.
 */
export function renderPublicReport(record: AuditRecord, opts: PublicReportOptions): string {
  const name = record.request.business_name;
  const location = record.request.location;
  const service = record.understanding?.service ?? 'your service';
  const base = publicPath(opts.token);
  const cta = opts.ctaLabel ?? 'Talk to us about improving your AI visibility';
  const date = formatDate(record.updatedAt);
  const beacon = opts.session ? engagementScript(base, opts.session, opts.engagementDelayMs ?? 2000) : '';
  const competitors = record.topCompetitors.map((c) => c.name);
  const states: Record<Layer, LayerState> = {
    VISIBLE: record.layers.VISIBLE.state,
    RECOMMENDED: record.layers.RECOMMENDED.state,
    CONVERSATIONAL: record.layers.CONVERSATIONAL.state,
  };
  const shots: Record<Layer, string[]> = {
    VISIBLE: record.evidence.visibleScreenshots.map(fileName),
    RECOMMENDED: record.evidence.recommendedScreenshots.map(fileName),
    CONVERSATIONAL: record.evidence.conversationalScreenshots.map(fileName),
  };

  const card = (layer: Layer) => {
    const c = LAYER_COPY[layer];
    const s = stateWord(states[layer]);
    return `<div class="card ${s}"><div class="k">${esc(c.title)}</div><div class="v">${s}</div><p>${esc(s === 'YES' ? c.yes : c.no)}</p></div>`;
  };

  const evidence = (layer: Layer) => {
    const c = LAYER_COPY[layer];
    const prompt = record.layers[layer].prompt ?? '';
    const imgs = shots[layer]
      .map((f, i) => `<figure><img loading="lazy" src="${esc(`${base}/evidence/${encodeURIComponent(f)}`)}" alt="${esc(`${c.title} test screenshot ${i + 1}`)}"><figcaption>ChatGPT, ${esc(c.title)} test${shots[layer].length > 1 ? `, step ${i + 1}` : ''}</figcaption></figure>`)
      .join('');
    return `<details><summary><span>${esc(c.title)} test</span><span class="tag ${stateWord(states[layer])}">${stateWord(states[layer])}</span></summary>
      <p class="q">We asked: <em>“${esc(prompt)}”</em>${layer === 'CONVERSATIONAL' ? ' and then continued the conversation to ask who we should speak to.' : ''}</p>
      ${imgs || '<p class="muted">Screenshot unavailable for this test.</p>'}</details>`;
  };

  const competitorsBlock = competitors.length
    ? `<ol class="comp">${competitors.map((c) => `<li>${esc(c)}</li>`).join('')}</ol>
       <p class="muted">These are the businesses ChatGPT named in our tests, ranked by how strongly it put them forward.</p>`
    : `<p>ChatGPT did not name specific ${esc(service)} businesses in our tests. That is an opportunity: the first business it learns to trust here will own that recommendation.</p>`;

  const headline =
    states.CONVERSATIONAL === 'YES' && states.RECOMMENDED === 'YES'
      ? `ChatGPT is recommending ${esc(name)}. The job now is to keep it that way.`
      : states.VISIBLE === 'YES'
        ? `ChatGPT knows ${esc(name)} exists, but it is recommending other businesses.`
        : `When people in ${esc(location)} ask ChatGPT about ${esc(service)}, ${esc(name)} is not part of the answer.`;

  return `<!doctype html>
<html lang="en-GB">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>AI Visibility Report for ${esc(name)}</title>
<style>
  :root{--ink:#0f172a;--muted:#64748b;--line:#e2e8f0;--yes:#15803d;--no:#b91c1c;--accent:#1d4ed8;--bg:#f8fafc}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  main{max-width:820px;margin:0 auto;padding:36px 20px 72px}
  .brand{font-size:13px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 18px}
  h1{font-size:30px;line-height:1.2;margin:0 0 8px}
  .lede{font-size:18px;color:#334155;margin:0 0 28px}
  h2{font-size:14px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:34px 0 12px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:14px}
  @media(max-width:640px){.cards{grid-template-columns:1fr}}
  .card{background:#fff;border:1px solid var(--line);border-radius:12px;padding:18px}
  .card .k{font-weight:700}
  .card .v{font-size:30px;font-weight:800;margin:4px 0 6px}
  .card.YES .v,.tag.YES{color:var(--yes)} .card.NO .v,.tag.NO{color:var(--no)}
  .card p{margin:0;color:#334155;font-size:14px}
  .box{background:#fff;border:1px solid var(--line);border-radius:12px;padding:20px}
  .comp{margin:0;padding-left:22px;font-size:18px} .comp li{margin:4px 0;font-weight:600}
  .muted{color:var(--muted);font-size:14px}
  details{background:#fff;border:1px solid var(--line);border-radius:12px;padding:0 18px;margin:10px 0}
  summary{cursor:pointer;padding:14px 0;font-weight:600;display:flex;justify-content:space-between;align-items:center}
  .tag{font-size:13px;font-weight:800}
  .q{margin:0 0 12px;color:#334155}
  figure{margin:0 0 18px}
  figure img{width:100%;border:1px solid var(--line);border-radius:8px}
  figcaption{font-size:13px;color:var(--muted);margin-top:6px}
  .cta{display:block;text-align:center;background:var(--accent);color:#fff;text-decoration:none;font-weight:700;font-size:18px;padding:16px 22px;border-radius:12px;margin:12px 0 8px}
  .cta:hover{background:#1e40af}
  footer{margin-top:40px;font-size:13px;color:var(--muted)}
</style>
</head>
<body>
<main>
  <p class="brand">AIListings · AI Visibility Report</p>
  <h1>${headline}</h1>
  <p class="lede">We tested how the ChatGPT consumer app answers when someone in ${esc(location)} asks about ${esc(service)}${date ? `, on ${esc(date)}` : ''}. Here is what it showed.</p>

  <h2>What we tested</h2>
  <div class="box">
    <p style="margin:0 0 10px">Three kinds of question a real customer asks ChatGPT, each in a fresh chat so nothing carried over:</p>
    <ol style="margin:0;padding-left:22px">
      <li><b>Visible</b>: ${esc(LAYER_COPY.VISIBLE.question)}</li>
      <li><b>Recommended</b>: ${esc(LAYER_COPY.RECOMMENDED.question)}</li>
      <li><b>Conversational</b>: ${esc(LAYER_COPY.CONVERSATIONAL.question)}</li>
    </ol>
  </div>

  <h2>Results for ${esc(name)}</h2>
  <div class="cards">${card('VISIBLE')}${card('RECOMMENDED')}${card('CONVERSATIONAL')}</div>

  <h2>Who ChatGPT put forward</h2>
  <div class="box">${competitorsBlock}</div>

  <h2>Why visible is not the same as recommended</h2>
  <div class="box">
    <p style="margin:0">Being <b>visible</b> means ChatGPT knows your business exists and can list it when someone searches directly. Being <b>recommended</b> means that when a customer asks who they should actually use, or describes their problem and asks who to speak to, ChatGPT puts your name forward. Customers act on recommendations, not lists. Most businesses that appear in a search are still absent from the recommendation, and that gap is where the enquiries go.</p>
  </div>

  <a class="cta" href="${esc(`${base}/cta`)}">${esc(cta)}</a>
  <p class="muted" style="text-align:center">We will walk you through these results and what would change them.</p>

  <h2>Evidence</h2>
  ${LAYERS.map(evidence).join('')}

  <footer>Results reflect the answers ChatGPT displayed when we ran these tests${date ? ` on ${esc(date)}` : ''}. ChatGPT answers vary between sessions; screenshots are provided so you can see exactly what we saw. Prepared for ${esc(name)}, ${esc(location)}.</footer>
</main>
${beacon}
</body>
</html>`;
}

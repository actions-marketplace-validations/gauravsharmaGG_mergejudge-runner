import type { Story } from "./story.js";
// ---------- safety ----------
const esc = (s: unknown) => String(s ?? '')
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const clean = (s: unknown) => String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- text metrics (no font access; conservative estimate for system sans) ----------
function charW(c: string) {
  if (c === ' ') return 0.28;
  if ('il.,:;!|\'`'.includes(c)) return 0.26;
  if ('fjrt()[]{}/'.includes(c)) return 0.36;
  if ('mwMW'.includes(c)) return 0.86;
  if (/[A-Z]/.test(c)) return 0.66;
  if (/[0-9]/.test(c)) return 0.57;
  if ('→×−·'.includes(c)) return 0.62;
  return 0.54;
}
const textW = (t: string, size: number, bold = false, mono = false) =>
  mono ? t.length * size * 0.61 : [...t].reduce((a, c) => a + charW(c), 0) * size * (bold ? 1.07 : 1) * 1.03;

export function wrap(text: string, maxW: number, size: number, maxLines: number, bold = false, mono = false) {
  const words = clean(text).split(' ').filter(Boolean);
  const lines = []; let cur = '';
  for (const w of words) {
    const t = cur ? cur + ' ' + w : w;
    if (textW(t, size, bold, mono) <= maxW) { cur = t; continue; }
    if (cur) lines.push(cur);
    cur = w;
    while (textW(cur, size, bold, mono) > maxW) { // hard-break very long tokens
      let k = cur.length; while (k > 1 && textW(cur.slice(0, k), size, bold, mono) > maxW) k--;
      lines.push(cur.slice(0, k)); cur = cur.slice(k);
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    const keep = lines.slice(0, maxLines);
    let last = keep[maxLines - 1]! + '…';
    while (textW(last, size, bold, mono) > maxW && last.length > 2) last = last.slice(0, -2) + '…';
    keep[maxLines - 1]! = last; return keep;
  }
  return lines;
}

// ---------- normalize story ----------
function normalize(story: Story) {
 const steps = story.steps.map((s, i) => ({ ...s, n: i + 1, sub: s.sub ?? "", before: s.before ?? "", after: s.after ?? "" }));
 const edgeMap = new Map(story.edges.map(e => [`${e.from}>${e.to}`, e.change]));
 const segs = steps.slice(1).map((b, i) => { const c = edgeMap.get(`${steps[i]!.id}>${b.id}`); return c && c !== "same" ? c : b.change; });
 return { title: story.title, steps, segs };
}
type Normal = ReturnType<typeof normalize>;
type Step = Normal["steps"][number];
// ---------- shared style ----------
const FONT = `-apple-system,BlinkMacSystemFont,'Segoe UI','Noto Sans',Helvetica,Arial,sans-serif`;
const MONO = `ui-monospace,SFMono-Regular,'SF Mono',Menlo,Consolas,'Liberation Mono',monospace`;
function baseCss(extra = '') {
  return `
:root{--bg:#ffffff;--bg2:#f6f8fa;--bd:#d1d9e0;--fg:#1f2328;--mu:#59636e;--fa:#818b98;
--ch:#bf8700;--chs:#fff8c5;--chb:#f2cc60;--nw:#1a7f37;--nws:#dafbe1;--nwb:#4ac26b;--sm:#afb8c1;--sms:#f6f8fa;
--dl:#cf222e;--dls:#ffebe9;--ad:#1a7f37;--ads:#dafbe1;--pu:#8250df;--pus:#fbefff}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--bg2:#151b23;--bd:#3d444d;--fg:#f0f6fc;--mu:#9198a1;--fa:#656c76;
--ch:#d29922;--chs:#bb800933;--chb:#9e6a03;--nw:#3fb950;--nws:#2ea04326;--nwb:#238636;--sm:#3d444d;--sms:#151b23;
--dl:#f85149;--dls:#f8514921;--ad:#3fb950;--ads:#2ea04326;--pu:#ab7df8;--pus:#ab7df826}}
text{font-family:${FONT};fill:var(--fg)}
.mono{font-family:${MONO}}
.t{font-size:15px;font-weight:600}.s{font-size:11.5px;fill:var(--mu)}.h{font-size:12px;font-weight:600;letter-spacing:.06em;fill:var(--mu)}
.lg{font-size:11px;fill:var(--mu)}.pt{font-size:12px}.ptm{fill:var(--mu)}
.bg{fill:var(--bg);stroke:var(--bd)}
.f-ch{fill:var(--ch)}.f-nw{fill:var(--nw)}.f-sm{fill:var(--sm)}.f-bg{fill:var(--bg)}.f-bg2{fill:var(--bg2)}
.k-ch{stroke:var(--ch)}.k-nw{stroke:var(--nw)}.k-sm{stroke:var(--sm)}.k-bd{stroke:var(--bd)}
.fs-ch{fill:var(--chs)}.fs-nw{fill:var(--nws)}.fs-sm{fill:var(--sms)}
.p-del{fill:var(--dls)}.p-add{fill:var(--ads)}.g-del{fill:var(--dl)}.g-add{fill:var(--ad)}
.pulse{fill:var(--pu)}.halo{fill:var(--pu);opacity:.22}
.in{animation:mjIn .55s cubic-bezier(.2,.8,.2,1) both}
@keyframes mjIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.draw{stroke-dasharray:var(--len);stroke-dashoffset:var(--len);animation:mjDraw .5s ease-out both}
@keyframes mjDraw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}.pulseG{display:none}}
${extra}`;
}

// pill: diff-style chip. kind: del|add
function pill(x: number, y: number, maxW: number, kind: string, text: string) {
  const size = 12, glyphW = 16, padR = 9, h = 22;
  const lines = wrap(text, maxW - glyphW - padR - 6, size, 2);
  const w = Math.min(maxW, glyphW + 6 + Math.max(...lines.map((l) => textW(l, size))) + padR);
  const hh = h + (lines.length - 1) * 16;
  const g = kind === 'del' ? '−' : '+';
  let s = `<rect x="${x}" y="${y}" width="${w.toFixed(1)}" height="${hh}" rx="6" class="p-${kind}"/>`;
  s += `<text x="${x + 9}" y="${y + 15.5}" class="pt mono g-${kind}" font-weight="700">${g}</text>`;
  lines.forEach((l, i) => { s += `<text x="${x + glyphW + 6}" y="${y + 15.5 + i * 16}" class="pt${kind === 'del' ? ' ptm' : ''}">${esc(l)}</text>`; });
  return { svg: s, h: hh };
}

// content block for one step (title / sub / pills). returns {svg, h}
function content(st: Step, x: number, y: number, maxW: number) {
  let s = '', cy = y;
  const tl = wrap(st.title, maxW, 15, 2, true);
  tl.forEach((l, i) => { s += `<text x="${x}" y="${cy + 15 + i * 19}" class="t">${esc(l)}</text>`; });
  cy += 15 + (tl.length - 1) * 19;
  if (st.sub) { const sl = wrap(st.sub, maxW, 11.5, 1, false, true); s += `<text x="${x}" y="${cy + 17}" class="s mono">${esc(sl[0]!)}</text>`; cy += 17; }
  cy += 5;
  const pills: [string, string][] = [];
  if (st.change === 'changed' && st.before) pills.push(['del', st.before]);
  if (st.after) pills.push(['add', st.after]);
  for (const [k, t] of pills) { const p = pill(x, cy + 4, maxW, k, t); s += p.svg; cy += p.h + 6; }
  return { svg: s, h: cy - y + (pills.length ? 0 : 1) };
}

function legend(x: number, y: number, W: number) {
  const items: [string, string][] = [['ch', 'Changed'], ['nw', 'New'], ['sm', 'Unchanged']];
  let s = '', cx = x;
  for (const [k, t] of items) {
    s += k === 'sm' ? `<circle cx="${cx + 4}" cy="${y - 4}" r="3.5" fill="none" stroke-width="1.5" class="k-sm"/>` : `<circle cx="${cx + 4}" cy="${y - 4}" r="4" class="f-${k}"/>`;
    s += `<text x="${cx + 12}" y="${y}" class="lg">${t}</text>`; cx += 12 + textW(t, 11) + 14;
  }
  s += `<text x="${W - 20}" y="${y}" class="lg" text-anchor="end" fill-opacity=".8">MergeJudge</text>`;
  return s;
}
function header(story: Normal, W: number) {
  const c = story.steps.filter((s) => s.change === 'changed').length, n = story.steps.filter((s) => s.change === 'new').length;
  let s = `<text x="20" y="31" class="h">${esc(story.title.toUpperCase())}</text>`;
  const parts = [`${story.steps.length} steps`]; if (c) parts.push(`${c} changed`); if (n) parts.push(`${n} new`);
  s += `<text x="${W - 20}" y="31" class="lg" text-anchor="end">${esc(parts.join(' · '))}</text>`;
  return s;
}

// pulse keyframes along a polyline of points; returns css + per-point arrival fractions
function pulseAnim(pts: [number, number][], period: number, travel: number, begin: number) {
  const L = [0]; for (let i = 1; i < pts.length; i++) L.push(L[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
  const tot = L[L.length - 1]! || 1;
  const pct = (d: number) => ((d / tot) * travel * 100);
  let kf = `0%{transform:translate(${pts[0]![0]}px,${pts[0]![1]}px);opacity:0}3%{opacity:1}`;
  pts.forEach((p, i) => { kf += `${pct(L[i]!).toFixed(2)}%{transform:translate(${p[0]}px,${p[1]}px)}`; });
  const last = pts[pts.length - 1]!;
  kf = kf.replace(`${pct(L[pts.length - 1]!).toFixed(2)}%{`, `${pct(L[pts.length - 1]!).toFixed(2)}%{opacity:1;`);
  kf += `${(travel * 100 + 6).toFixed(2)}%,100%{transform:translate(${last[0]}px,${last[1]}px);opacity:0}`;
  const css = `@keyframes mjPulse{${kf}}.pulseG{animation:mjPulse ${period}s linear ${begin}s infinite both}`;
  return { css, frac: (d: number) => (d / tot) * travel, L };
}
// glow keyframes firing at fraction f of the period
function glowKf(name: string, f: number, peak = 1) {
  const a = Math.max(0, f * 100 - 2), b = f * 100 + 3, c = Math.min(99, f * 100 + 26);
  return `@keyframes ${name}{0%,${a.toFixed(1)}%{opacity:0}${b.toFixed(1)}%{opacity:${peak}}${c.toFixed(1)}%,100%{opacity:0}}`;
}

const svgOpen = (W: number, H: number, label: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">`;
const sc = (c: string) => (c === 'changed' ? 'ch' : c === 'new' ? 'nw' : 'sm');
const PERIOD = 5, TRAVEL = 0.5;

// ========== Variant C: subway map ==========
function subway(story: Normal, W: number) {
  const L0 = 34, LANE = 26, top = 58, GAP = 14;
  let y = top; const rows: { st: Step; y: number; x: number; c: {svg: string; h: number}; h: number }[] = [];
  story.steps.forEach((st) => {
    const lane = st.change === 'new' && story.steps.some((s) => s.change !== 'new') ? 1 : 0;
    const x = L0 + lane * LANE, tx = L0 + LANE + 30;
    const c = content(st, tx, y - 11, W - tx - 22);
    rows.push({ st, y, x, c, h: c.h }); y += Math.max(c.h, 30) + GAP + 8;
  });
  const H = y - GAP + 38;
  // build line path with curves on lane switch; sample points for pulse
  const pts: [number, number][] = [[rows[0]!.x, rows[0]!.y]]; const segPaths: string[] = []; const stationIdx = [0];
  rows.slice(1).forEach((r, i) => {
    const a = rows[i]!; let d;
    if (a.x === r.x) { d = `M${a.x} ${a.y}V${r.y}`; pts.push([r.x, r.y]); }
    else {
      const m1 = a.y + (r.y - a.y) * 0.25, m2 = a.y + (r.y - a.y) * 0.75;
      d = `M${a.x} ${a.y}V${m1}C${a.x} ${(m1 + m2) / 2} ${r.x} ${(m1 + m2) / 2} ${r.x} ${m2}V${r.y}`;
      pts.push([a.x, m1]);
      for (let t = 1; t <= 8; t++) { const u = t / 8, mt = 1 - u; const cy = (m1 + m2) / 2;
        const bx = mt * mt * mt * a.x + 3 * mt * mt * u * a.x + 3 * mt * u * u * r.x + u * u * u * r.x;
        const by = mt * mt * mt * m1 + 3 * mt * mt * u * cy + 3 * mt * u * u * cy + u * u * u * m2; pts.push([+bx.toFixed(1), +by.toFixed(1)]); }
      pts.push([r.x, r.y]);
    }
    stationIdx.push(pts.length - 1); segPaths.push(d);
  });
  const P = pulseAnim(pts, PERIOD, TRAVEL, 1.5);
  let css = P.css + `.st{stroke-width:4}`, body = '';
  // ghost main line continuing (shows the branch leaves the existing line)
  const last = rows[rows.length - 1]!;
  body += `<path d="M${L0} ${rows[0]!.y - 18}V${rows[0]!.y}" stroke-width="6" stroke-linecap="round" class="k-${sc(rows[0]!.st.change) === 'sm' ? 'sm' : sc(rows[0]!.st.change)}" opacity=".9"/>`;
  segPaths.forEach((d, i) => {
    const k = sc(story.segs[i]!);
    body += `<path d="${d}" fill="none" stroke-width="6" stroke-linecap="round" class="k-${k}"/>`;
  });
  body += `<path d="M${last.x} ${last.y}v24" stroke-width="6" stroke-linecap="round" class="k-${sc(last.st.change)}"/>`;
  body += `<path d="M${last.x - 9} ${last.y + 24}h18" stroke-width="4" stroke-linecap="round" class="k-${sc(last.st.change)}"/>`;
  rows.forEach((r, i) => {
    const k = sc(r.st.change), d = (0.1 + i * 0.16).toFixed(2);
    let g = `<g class="in" style="animation-delay:${d}s">`;
    if (k !== 'sm') {
      g += `<circle cx="${r.x}" cy="${r.y}" r="17" class="f-${k}" fill-opacity=".3" style="opacity:0;animation:gl${i} ${PERIOD}s linear 1.5s infinite"/>`;
      css += glowKf(`gl${i}`, P.frac(P.L[stationIdx[i]!]!));
    }
    if (k === 'ch') g += `<rect x="${r.x - 11}" y="${r.y - 11}" width="22" height="22" rx="11" class="f-bg k-ch" stroke-width="4"/><circle cx="${r.x}" cy="${r.y}" r="3.5" class="f-ch"/>`;
    else g += `<circle cx="${r.x}" cy="${r.y}" r="9" class="f-bg k-${k}" stroke-width="4"/>`;
    // tick from station to label
    const tx = L0 + LANE + 30;
    g += `<path d="M${r.x + 14} ${r.y}H${tx - 8}" stroke-width="1.5" stroke-dasharray="2 3" class="k-bd"/>`;
    g += r.c.svg + `</g>`; body += g;
  });
  const pulse = `<g class="pulseG"><circle r="9" class="halo"/><circle r="3.5" style="fill:#fff"/></g>`;
  return svgOpen(W, H, story.title) + `<style>${baseCss(css)}</style><rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" class="bg"/>` +
    header(story, W) + pulseUnder(body, pulse) + legend(20, H - 14, W) + `</svg>`;
}

// put the pulse under station markers: after line segments, before step groups
function pulseUnder(body: string, pulse: string) { const i = body.indexOf('<g class="in"'); return i < 0 ? body + pulse : body.slice(0, i) + pulse + body.slice(i); }


export function renderStorySvg(story: Story, opts: { width?: number; animate?: boolean } = {}): string {
 const width = Number.isFinite(opts.width) ? Math.max(280, Math.min(1000, Math.round(opts.width!))) : 440;
 let svg = subway(normalize(story), width);
 if (opts.animate === false) {
   // Remove animation CSS and animation-only glows/pulse; the base content is visible immediately.
   svg = svg.replace(/<g class="pulseG">[\s\S]*?<\/g>/g, "")
     .replace(/<circle[^>]*style="opacity:0;animation:[^"]*"\/>/g, "")
     .replace(/@keyframes [^{]+\{(?:[^{}]|\{[^{}]*\})*\}/g, "")
     .replace(/animation(?:-delay)?:[^;}" ]+(?:[^;}" ]| )*;?/g, "")
     .replace(/\.draw\{[^}]*\}/g, "")
     .replace(/style="animation-delay:[^"]*"/g, "");
 }
 return svg;
}

/**
 * lib/html-builder.js — writes static lead-gen site files to disk
 *
 * Exports:
 *   siteSlug(niche, city, state)    → "emergency-plumber-houston-tx"
 *   buildSiteFiles(slug, content, opp) → writes index.html + thanks.html
 *
 * Output: /inbound/sites/<slug>/index.html  (lead capture page)
 *         /inbound/sites/<slug>/thanks.html (post-submit confirmation)
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SITES_DIR = path.resolve(__dirname, '../sites');

// ─── Slug helper ─────────────────────────────────────────────────────────────

export function siteSlug(niche, city, state) {
  const slugify = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${slugify(niche)}-${slugify(city)}-${slugify(state)}`;
}

// ─── CSS (inlined for zero external requests) ─────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#f8f9fa;color:#1a1a1a;line-height:1.6}
a{color:inherit}
.hero{background:linear-gradient(135deg,#1a2744 0%,#0f3d6e 100%);color:#fff;padding:56px 20px 48px;text-align:center}
.hero h1{font-size:clamp(1.6rem,4vw,2.6rem);font-weight:800;line-height:1.2;max-width:680px;margin:0 auto 14px}
.hero p{font-size:1.1rem;opacity:.88;max-width:560px;margin:0 auto 28px}
.tagline{font-size:.8rem;opacity:.6;margin-top:14px;letter-spacing:.05em;text-transform:uppercase}
.btn{display:inline-block;background:#f97316;color:#fff;font-weight:700;font-size:1.05rem;padding:14px 32px;border-radius:8px;border:none;cursor:pointer;text-decoration:none;transition:background .15s}
.btn:hover{background:#ea6c0a}
.trust{display:flex;flex-wrap:wrap;justify-content:center;gap:10px 24px;padding:22px 20px;background:#fff;border-bottom:1px solid #e5e7eb}
.trust span{font-size:.85rem;font-weight:600;color:#374151;display:flex;align-items:center;gap:6px}
.trust span::before{content:'✓';color:#16a34a;font-weight:800}
.section{padding:52px 20px;max-width:900px;margin:0 auto}
.section h2{font-size:1.55rem;font-weight:700;margin-bottom:28px;text-align:center}
.services{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:18px}
.service{background:#fff;border-radius:10px;padding:22px;box-shadow:0 1px 4px rgba(0,0,0,.08)}
.service h3{font-size:1rem;font-weight:700;margin-bottom:8px;color:#1a2744}
.service p{font-size:.9rem;color:#4b5563}
.form-section{background:#1a2744;color:#fff;padding:52px 20px}
.form-section h2{font-size:1.4rem;font-weight:700;text-align:center;margin-bottom:28px}
.form-wrap{max-width:520px;margin:0 auto;display:flex;flex-direction:column;gap:14px}
.form-wrap input,.form-wrap select,.form-wrap textarea{width:100%;padding:13px 16px;border-radius:8px;border:none;font-size:1rem;font-family:inherit;background:#fff;color:#1a1a1a}
.form-wrap textarea{min-height:90px;resize:vertical}
.form-wrap .btn{width:100%;font-size:1.1rem;padding:16px}
.about{background:#fff}
.about-inner{max-width:700px;margin:0 auto;text-align:center}
.about-inner p{font-size:1rem;color:#374151;line-height:1.75}
details{border-bottom:1px solid #e5e7eb}
details summary{padding:16px 4px;font-weight:600;cursor:pointer;list-style:none;display:flex;justify-content:space-between;align-items:center}
details summary::after{content:'+';font-size:1.3rem;color:#6b7280;transition:transform .2s}
details[open] summary::after{transform:rotate(45deg)}
details p{padding:0 4px 16px;color:#4b5563;font-size:.95rem}
footer{background:#111827;color:#9ca3af;text-align:center;padding:28px 20px;font-size:.85rem}
@media(max-width:600px){.hero{padding:40px 16px 36px}.hero h1{font-size:1.5rem}.section{padding:36px 16px}.services{grid-template-columns:1fr}.form-section{padding:36px 16px}}
`;

// ─── JSON-LD schema ───────────────────────────────────────────────────────────

function buildSchema(content, opp) {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': content.schema_service_type || 'LocalBusiness',
    name: `${opp.niche} — ${opp.city}, ${opp.state}`,
    description: content.metaDescription,
    areaServed: { '@type': 'City', name: opp.city },
  });
}

// ─── index.html ───────────────────────────────────────────────────────────────

function buildIndex(slug, content, opp) {
  const trustHtml = (content.trust_signals || []).map(t => `<span>${t}</span>`).join('\n    ');

  const servicesHtml = (content.services || []).map(s =>
    `<div class="service"><h3>${esc(s.name)}</h3><p>${esc(s.description)}</p></div>`
  ).join('\n    ');

  const faqHtml = (content.faq || []).map(f =>
    `<details><summary>${esc(f.question)}</summary><p>${esc(f.answer)}</p></details>`
  ).join('\n  ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(content.headline)}</title>
<meta name="description" content="${esc(content.metaDescription)}">
<style>${CSS}</style>
<script type="application/ld+json">${buildSchema(content, opp)}</script>
</head>
<body>

<section class="hero">
  <h1>${esc(content.headline)}</h1>
  <p>${esc(content.subheadline)}</p>
  <a href="#get-help" class="btn">${esc(content.cta_text)}</a>
  <div class="tagline">${esc(content.tagline)}</div>
</section>

<div class="trust">
  ${trustHtml}
</div>

<section class="section">
  <h2>Services We Connect You With</h2>
  <div class="services">
    ${servicesHtml}
  </div>
</section>

<section class="form-section" id="get-help">
  <h2>${esc(content.form_headline)}</h2>
  <form class="form-wrap" method="POST" action="/leads/capture">
    <input type="hidden" name="site_slug" value="${slug}">
    <input type="text" name="name" placeholder="Your Name" required>
    <input type="tel" name="phone" placeholder="Phone Number" required>
    <input type="email" name="email" placeholder="Email Address" required>
    <textarea name="service_requested" placeholder="Describe what you need…" required></textarea>
    <button type="submit" class="btn">${esc(content.cta_text)}</button>
  </form>
</section>

<section class="section about">
  <div class="about-inner">
    <h2>About This Service</h2>
    <p>${esc(content.about_paragraph)}</p>
  </div>
</section>

<section class="section" style="padding-top:0">
  <h2>Frequently Asked Questions</h2>
  ${faqHtml}
</section>

<footer>
  <p>${esc(content.footer_tagline)}</p>
</footer>

</body>
</html>`;
}

// ─── thanks.html ──────────────────────────────────────────────────────────────

function buildThanks(content, opp) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Request Received — ${esc(opp.city)}, ${esc(opp.state)}</title>
<style>${CSS}
.thanks{min-height:80vh;display:flex;align-items:center;justify-content:center;text-align:center;padding:40px 20px}
.thanks-card{max-width:500px}
.check{font-size:3.5rem;margin-bottom:20px}
.thanks h1{font-size:1.9rem;font-weight:800;color:#1a2744;margin-bottom:14px}
.thanks p{color:#4b5563;font-size:1.05rem;line-height:1.7}
.thanks a{display:inline-block;margin-top:28px;color:#f97316;font-weight:600;font-size:.95rem}
</style>
</head>
<body>

<div class="thanks">
  <div class="thanks-card">
    <div class="check">✅</div>
    <h1>${esc(content.thank_you_headline)}</h1>
    <p>${esc(content.thank_you_body)}</p>
    <a href="/">← Back to Home</a>
  </div>
</div>

<footer>
  <p>${esc(content.footer_tagline)}</p>
</footer>

</body>
</html>`;
}

// ─── Escape helper ────────────────────────────────────────────────────────────

function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ─── Main export ──────────────────────────────────────────────────────────────

export function buildSiteFiles(slug, content, opp) {
  const dir = path.join(SITES_DIR, slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.html'), buildIndex(slug, content, opp), 'utf8');
  fs.writeFileSync(path.join(dir, 'thanks.html'), buildThanks(content, opp), 'utf8');
  return dir;
}

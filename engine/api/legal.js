/**
 * api/legal.js — Terms of Service and Privacy Policy pages
 *
 * GET /terms  → Terms of Service
 * GET /policy → Privacy Policy
 */

import express from 'express';
export const legalRouter = express.Router();

const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600;8..60,700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">`;

const BASE_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  ::selection{background:#1a1a1a;color:#faf9f6}
  body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh}
  nav{height:64px;display:flex;align-items:center;border-bottom:1px solid #e8e5e0;background:#faf9f6}
  .nav-inner{max-width:1100px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,48px)}
  .nav-logo{font-family:'Outfit',sans-serif;font-size:28px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
  .wrap{max-width:720px;margin:0 auto;padding:72px clamp(20px,4vw,48px) 0}
  .section-label{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;text-transform:uppercase;letter-spacing:2.5px;color:#888;margin-bottom:12px}
  h1{font-size:clamp(32px,4.5vw,48px);font-weight:400;line-height:1.1;letter-spacing:-1px;margin-bottom:12px}
  h1 em{font-style:italic}
  .meta{font-family:'Outfit',sans-serif;font-size:15px;color:#999;margin-bottom:48px}
  .divider{border-top:1px solid #e8e5e0;margin:40px 0}
  h2{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;color:#1a1a1a;margin-bottom:12px}
  p{font-family:'Outfit',sans-serif;font-size:16px;color:#555;line-height:1.8;margin-bottom:16px}
  p:last-child{margin-bottom:0}
  ul{font-family:'Outfit',sans-serif;font-size:16px;color:#555;line-height:1.8;padding-left:20px;margin-bottom:16px}
  li{margin-bottom:6px}
  a{color:#1a1a1a}
  .section{margin-bottom:40px}
  footer{border-top:1px solid #e8e5e0;margin-top:64px;padding:36px 0 48px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
  .footer-logo{font-family:'Outfit',sans-serif;font-size:18px;font-weight:700;letter-spacing:-.5px}
  .footer-links{display:flex;align-items:center;gap:24px;flex-wrap:wrap}
  .footer-link{font-family:'Outfit',sans-serif;font-size:14px;color:#888;text-decoration:none;transition:color .15s}
  .footer-link:hover{color:#1a1a1a}
  .footer-copy{font-family:'Outfit',sans-serif;font-size:14px;color:#888}
`;

function shell(title, sectionLabel, heading, headingEm, updatedDate, bodyHtml) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${title} — Suparade</title>
  ${FONTS}
  <style>${BASE_CSS}</style>
</head>
<body>
<nav>
  <div class="nav-inner">
    <a href="https://suparade.com" class="nav-logo">Suparade</a>
  </div>
</nav>
<div class="wrap">
  <div class="section-label">${sectionLabel}</div>
  <h1>${heading} <em>${headingEm}</em></h1>
  <p class="meta">Last updated: ${updatedDate}</p>

  ${bodyHtml}

  <footer>
    <div class="footer-logo">Suparade</div>
    <div class="footer-links">
      <a href="/terms" class="footer-link">Terms</a>
      <a href="/policy" class="footer-link">Policy</a>
      <a href="/admin" class="footer-link">Admin</a>
      <span class="footer-copy">© 2026 Suparade. All rights reserved.</span>
    </div>
  </footer>
</div>
</body>
</html>`;
}

// ─── Terms of Service ─────────────────────────────────────────────────────────

const TERMS_BODY = `
<div class="section">
  <h2>1. Service Description</h2>
  <p>Suparade provides done-for-you cold email lead generation for local service businesses. We research prospects, write personalized outreach emails, and deliver qualified replies to your inbox. You are responsible for following up and closing.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>2. Subscription and Billing</h2>
  <p>Services are billed monthly in advance. By subscribing, you authorize Suparade to charge your payment method on a recurring monthly basis. All fees are non-refundable except as required by law.</p>
  <ul>
    <li>Starter: $499/month — 500 prospects contacted</li>
    <li>Growth: $899/month — 1,000 prospects contacted</li>
    <li>Scale: $1,495/month — 2,000 prospects contacted</li>
  </ul>
</div>
<div class="divider"></div>

<div class="section">
  <h2>3. Cancellation</h2>
  <p>You may cancel at any time. Cancellation takes effect at the end of your current billing period. No partial refunds are issued for unused time. To cancel, email us at <a href="mailto:chike.a.obi@gmail.com">chike.a.obi@gmail.com</a>.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>4. Acceptable Use</h2>
  <p>You agree that the leads and outreach we deliver on your behalf will only be used for legitimate business solicitation. You may not use our service for spam, harassment, illegal offers, or industries prohibited by CAN-SPAM, CASL, or applicable local law. Violation results in immediate termination without refund.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>5. Results Disclaimer</h2>
  <p>Suparade does not guarantee specific reply rates, lead volume, or revenue outcomes. Performance varies by industry, offer, market conditions, and factors outside our control. Stated metrics (e.g. 8–15% reply rate) are estimates based on typical campaigns and are not guaranteed.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>6. Intellectual Property</h2>
  <p>All email copy, targeting strategies, and workflows created by Suparade remain the property of Suparade until fully paid. You retain ownership of your client list and any replies received.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>7. Limitation of Liability</h2>
  <p>Suparade's total liability for any claim arising from these terms or our service is limited to the fees you paid in the three months preceding the claim. We are not liable for indirect, consequential, or incidental damages.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>8. Contact</h2>
  <p>Questions about these terms? Email <a href="mailto:chike.a.obi@gmail.com">chike.a.obi@gmail.com</a>.</p>
</div>`;

// ─── Privacy Policy ───────────────────────────────────────────────────────────

const POLICY_BODY = `
<div class="section">
  <h2>1. What We Collect</h2>
  <p>When you sign up or fill out our onboarding form, we collect:</p>
  <ul>
    <li>Your name and email address</li>
    <li>Your target business niche and states</li>
    <li>Payment information (processed by Stripe — we never see your card number)</li>
  </ul>
  <p>We also collect prospect data (business names, emails, websites) through automated web research on your behalf.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>2. How We Use It</h2>
  <p>Your information is used solely to operate and improve your Suparade campaign:</p>
  <ul>
    <li>To configure and run your outreach campaigns</li>
    <li>To send you monthly performance reports</li>
    <li>To process your subscription via Stripe</li>
    <li>To communicate with you about your account</li>
  </ul>
  <p>We do not sell your data to third parties. We do not use it for advertising.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>3. Third-Party Services</h2>
  <p>We use the following services to operate Suparade:</p>
  <ul>
    <li><strong>Stripe</strong> — payment processing. Subject to <a href="https://stripe.com/privacy" target="_blank">Stripe's Privacy Policy</a>.</li>
    <li><strong>Supabase</strong> — secure database storage for your account and campaign data.</li>
    <li><strong>Instantly</strong> — email delivery infrastructure for outreach campaigns.</li>
    <li><strong>Anthropic Claude</strong> — AI used to research prospects and write personalized emails.</li>
  </ul>
</div>
<div class="divider"></div>

<div class="section">
  <h2>4. Data Retention</h2>
  <p>We retain your account data for as long as your subscription is active. Upon cancellation, your data is retained for 90 days, then deleted. You may request deletion at any time by emailing us.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>5. Security</h2>
  <p>All data is stored in encrypted databases. Access is restricted to Suparade's systems and is never exposed to the public. We use HTTPS for all data in transit.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>6. Your Rights</h2>
  <p>You have the right to access, correct, or delete your personal data at any time. To make a request, email <a href="mailto:chike.a.obi@gmail.com">chike.a.obi@gmail.com</a> and we will respond within 5 business days.</p>
</div>
<div class="divider"></div>

<div class="section">
  <h2>7. Contact</h2>
  <p>Privacy questions? Email <a href="mailto:chike.a.obi@gmail.com">chike.a.obi@gmail.com</a>.</p>
</div>`;

// ─── Routes ───────────────────────────────────────────────────────────────────

legalRouter.get('/terms', (_req, res) => {
  res.send(shell(
    'Terms of Service',
    'Legal',
    'Terms of',
    'Service.',
    'May 20, 2026',
    TERMS_BODY,
  ));
});

legalRouter.get('/policy', (_req, res) => {
  res.send(shell(
    'Privacy Policy',
    'Legal',
    'Privacy',
    'Policy.',
    'May 20, 2026',
    POLICY_BODY,
  ));
});

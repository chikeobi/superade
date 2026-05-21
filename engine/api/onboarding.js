/**
 * api/onboarding.js — Client intake form
 *
 * GET  /onboarding → two-step intake form (above the fold)
 * POST /onboarding → upserts into Supabase clients table
 */

import express from 'express';
import { supabase } from '../lib/supabase.js';

export const onboardingRouter = express.Router();

const TIER_QUOTAS = { starter: 500, growth: 1000, scale: 2000 };

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY','DC',
];

const NICHES = [
  'Dentist / Orthodontist',
  'Personal Injury Lawyer',
  'Family Lawyer',
  'Real Estate Agent',
  'Financial Advisor',
  'HVAC (commercial)',
  'Cosmetic Surgeon',
  'Med Spa',
  'Business Consultant',
  'Mortgage Broker',
  'Insurance Broker',
  'Solar Installation',
];

function formPage(errorMsg = '', step = 1) {
  const nichePills = NICHES.map(n =>
    `<input type="checkbox" name="niche" value="${n}" id="n-${n.replace(/\s/g,'-')}" class="sp-input">` +
    `<label for="n-${n.replace(/\s/g,'-')}" class="sp-label">${n}</label>`
  ).join('');

  const statePills = US_STATES.map(abbr =>
    `<input type="checkbox" name="states" value="${abbr}" id="s-${abbr}" class="sp-input">` +
    `<label for="s-${abbr}" class="sp-label">${abbr}</label>`
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Account Setup — Suparade</title>
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600;8..60,700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    ::selection{background:#1a1a1a;color:#faf9f6}
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh;display:flex;flex-direction:column}

    /* NAV — aligned to content width */
    nav{height:64px;display:flex;align-items:center;border-bottom:1px solid #e8e5e0}
    .nav-inner{max-width:600px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,32px)}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}

    /* LAYOUT */
    .wrap{max-width:600px;margin:0 auto;width:100%;padding:40px clamp(20px,4vw,32px) 0;flex:1}

    /* STEP TABS */
    .steps{display:flex;align-items:flex-end;gap:0;border-bottom:1px solid #e8e5e0;margin-bottom:36px}
    .step-tab{padding:0 0 16px;margin-right:36px;border-bottom:2px solid transparent;transition:border-color .2s}
    .step-tab.active{border-bottom-color:#1a1a1a}
    .step-n{font-family:'Outfit',sans-serif;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;color:#ccc;display:block;margin-bottom:4px;transition:color .2s}
    .step-tab.active .step-n{color:#1a1a1a}
    .step-tab.done .step-n{color:#16a34a}
    .step-name{font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;color:#ccc;transition:color .2s}
    .step-tab.active .step-name{color:#1a1a1a}
    .step-tab.done .step-name{color:#888}

    /* ERROR */
    .error{font-family:'Outfit',sans-serif;background:#fff0f0;border:1px solid #e00;border-radius:10px;padding:12px 16px;color:#c00;font-size:14px;margin-bottom:24px}

    /* FIELDS */
    .field{margin-bottom:22px}
    .field-label{font-family:'Outfit',sans-serif;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:2px;color:#888;margin-bottom:8px;display:block}
    .field-hint{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb;margin-top:6px}
    input[type=text],input[type=email]{
      width:100%;padding:13px 16px;
      border:1.5px solid #e8e5e0;border-radius:10px;
      font-family:'Source Serif 4',Georgia,serif;font-size:16px;color:#1a1a1a;
      background:#fff;outline:none;transition:border-color .2s;
    }
    input[type=text]::placeholder,input[type=email]::placeholder{color:#ccc}
    input[type=text]:focus,input[type=email]:focus{border-color:#1a1a1a}

    /* STATE PILLS */
    .pills-wrap{display:flex;flex-wrap:wrap;gap:6px;max-height:148px;overflow-y:auto;padding:2px 0}
    .sp-input{display:none}
    .sp-label{
      font-family:'Outfit',sans-serif;font-size:12px;font-weight:500;
      padding:5px 11px;border:1px solid #e0e0e0;border-radius:100px;
      color:#888;cursor:pointer;user-select:none;transition:all .12s;white-space:nowrap;
    }
    .sp-label:hover{border-color:#aaa;color:#1a1a1a}
    .sp-input:checked+.sp-label{background:#1a1a1a;color:#faf9f6;border-color:#1a1a1a}

    /* BUTTONS */
    .btn-primary{
      width:100%;margin-top:28px;padding:14px;
      background:#1a1a1a;color:#faf9f6;border:none;border-radius:100px;
      font-family:'Outfit',sans-serif;font-size:16px;font-weight:600;
      cursor:pointer;transition:all .25s;
    }
    .btn-primary:hover{background:#333;transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.12)}
    .btn-back{
      font-family:'Outfit',sans-serif;font-size:14px;font-weight:500;color:#aaa;
      background:none;border:none;cursor:pointer;margin-top:14px;
      display:block;text-align:center;width:100%;transition:color .15s;
    }
    .btn-back:hover{color:#1a1a1a}

    /* FOOTER */
    footer{border-top:1px solid #e8e5e0;margin-top:48px}
    .footer-inner{max-width:600px;margin:0 auto;padding:28px clamp(20px,4vw,32px) 40px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
    .footer-logo{font-family:'Outfit',sans-serif;font-size:16px;font-weight:700;letter-spacing:-.5px}
    .footer-links{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
    .footer-link{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb;text-decoration:none;transition:color .15s}
    .footer-link:hover{color:#1a1a1a}
    .footer-copy{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb}
  </style>
</head>
<body>

<nav>
  <div class="nav-inner">
    <a href="https://suparade.com" class="nav-logo">Suparade</a>
  </div>
</nav>

<div class="wrap">

  <!-- Step tabs -->
  <div class="steps">
    <div class="step-tab ${step === 1 ? 'active' : 'done'}" id="tab-1">
      <span class="step-n" id="num-1">${step > 1 ? '✓' : '01'}</span>
      <span class="step-name">About you</span>
    </div>
    <div class="step-tab ${step === 2 ? 'active' : ''}" id="tab-2">
      <span class="step-n">02</span>
      <span class="step-name">Your targets</span>
    </div>
  </div>

  ${errorMsg ? `<div class="error">${errorMsg}</div>` : ''}

  <!-- One form, two panels -->
  <form method="POST" action="/onboarding" id="main-form">

    <!-- Step 1 -->
    <div id="panel-1" ${step === 2 ? 'hidden' : ''}>
      <div class="field">
        <label class="field-label" for="name">Your full name</label>
        <input type="text" id="name" name="name" placeholder="Jane Smith" autocomplete="name">
      </div>
      <div class="field">
        <label class="field-label" for="email">Email address</label>
        <input type="email" id="email" name="email" placeholder="jane@example.com" autocomplete="email">
        <p class="field-hint">Same email you used at checkout.</p>
      </div>
      <button type="button" class="btn-primary" id="btn-next">Continue →</button>
    </div>

    <!-- Step 2 -->
    <div id="panel-2" ${step === 1 ? 'hidden' : ''}>
      <div class="field">
        <span class="field-label">Who you're targeting</span>
        <p class="field-hint" style="margin-bottom:10px">Select all that apply.</p>
        <div class="pills-wrap" style="max-height:none">${nichePills}</div>
      </div>
      <div class="field">
        <span class="field-label">Target cities <span style="font-weight:400;text-transform:none;letter-spacing:0;font-size:12px;color:#bbb">(optional)</span></span>
        <p class="field-hint" style="margin-bottom:10px">Add ZIP codes to target specific cities. When set, state selection below is skipped.</p>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:10px">
          <input type="text" id="city-zip-input" placeholder="ZIP code" maxlength="5" style="width:130px">
          <select id="city-miles-input" style="padding:13px 12px;border:1.5px solid #e8e5e0;border-radius:10px;font-family:'Outfit',sans-serif;font-size:15px;color:#1a1a1a;background:#fff;outline:none;-webkit-appearance:none;appearance:none">
            <option value="5">5 miles</option>
            <option value="10">10 miles</option>
            <option value="25" selected>25 miles</option>
            <option value="50">50 miles</option>
          </select>
          <button type="button" id="btn-add-city" style="padding:12px 18px;background:#1a1a1a;color:#faf9f6;border:none;border-radius:10px;font-family:'Outfit',sans-serif;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;flex-shrink:0">+ Add</button>
        </div>
        <div id="city-chips" style="display:flex;flex-wrap:wrap;gap:6px;min-height:4px"></div>
        <div id="city-hidden"></div>
      </div>
      <div class="field">
        <span class="field-label">Target states <span id="states-opt-hint" style="font-weight:400;text-transform:none;letter-spacing:0;font-size:12px;color:#bbb;display:none">(optional when cities are set)</span></span>
        <div class="pills-wrap">${statePills}</div>
      </div>
      <button type="submit" class="btn-primary">Complete Setup</button>
      <button type="button" class="btn-back" id="btn-back">← Back</button>
    </div>

  </form>
</div>

<footer>
  <div class="footer-inner">
    <div class="footer-logo">Suparade</div>
    <div class="footer-links">
      <a href="/terms" class="footer-link">Terms</a>
      <a href="/policy" class="footer-link">Policy</a>
      <a href="/admin" class="footer-link">Admin</a>
      <span class="footer-copy">© 2026 Suparade.</span>
    </div>
  </div>
</footer>

<script>
  var stepError = document.querySelector('.error');

  function showError(msg) {
    if (!stepError) {
      stepError = document.createElement('div');
      stepError.className = 'error';
      document.getElementById('panel-1').prepend(stepError);
    }
    stepError.textContent = msg;
    stepError.hidden = false;
  }

  document.getElementById('btn-next').addEventListener('click', function() {
    var name  = document.getElementById('name').value.trim();
    var email = document.getElementById('email').value.trim();
    var emailEl = document.getElementById('email');

    if (!name)  { showError('Please enter your name.'); return; }
    if (!email || !emailEl.checkValidity()) { showError('Please enter a valid email address.'); return; }
    if (stepError) stepError.hidden = true;

    document.getElementById('panel-1').hidden = true;
    document.getElementById('panel-2').hidden = false;
    document.getElementById('tab-1').className = 'step-tab done';
    document.getElementById('num-1').textContent = '✓';
    document.getElementById('tab-2').className = 'step-tab active';
  });

  document.getElementById('btn-back').addEventListener('click', function() {
    document.getElementById('panel-2').hidden = true;
    document.getElementById('panel-1').hidden = false;
    document.getElementById('tab-1').className = 'step-tab active';
    document.getElementById('num-1').textContent = '01';
    document.getElementById('tab-2').className = 'step-tab';
  });

  // ── City targeting ──────────────────────────────────────────────────────────
  var cities = [];

  function renderCityChips() {
    var chips  = document.getElementById('city-chips');
    var hidden = document.getElementById('city-hidden');
    var hint   = document.getElementById('states-opt-hint');
    chips.innerHTML = cities.map(function(c, i) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;background:#1a1a1a;color:#faf9f6;padding:5px 12px;border-radius:100px;font-family:Outfit,sans-serif;font-size:13px">' +
        c.zip + ' · ' + c.miles + ' mi' +
        '<button type="button" onclick="removeCity(' + i + ')" style="background:none;border:none;color:#faf9f6;cursor:pointer;font-size:16px;line-height:1;padding:0 0 0 4px">×</button></span>';
    }).join('');
    hidden.innerHTML = cities.map(function(c) {
      return '<input type="hidden" name="target_city" value=\'' + JSON.stringify(c) + '\'>';
    }).join('');
    hint.style.display = cities.length ? '' : 'none';
  }

  window.removeCity = function(i) {
    cities.splice(i, 1);
    renderCityChips();
  };

  document.getElementById('btn-add-city').addEventListener('click', function() {
    var zip   = document.getElementById('city-zip-input').value.trim();
    var miles = parseInt(document.getElementById('city-miles-input').value, 10);
    if (!/^\d{5}$/.test(zip)) { alert('Please enter a valid 5-digit ZIP code.'); return; }
    if (cities.find(function(c) { return c.zip === zip; })) { alert('That ZIP is already added.'); return; }
    cities.push({ zip: zip, miles: miles });
    renderCityChips();
    document.getElementById('city-zip-input').value = '';
  });
</script>

</body>
</html>`;
}

function successPage(firstName) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>You're all set — Suparade</title>
  <link href="https://fonts.googleapis.com/css2?family=Source+Serif+4:opsz,wght@8..60,300;8..60,400;8..60,500;8..60,600;8..60,700&family=Outfit:wght@300;400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
    body{font-family:'Source Serif 4',Georgia,serif;background:#faf9f6;color:#1a1a1a;min-height:100vh;display:flex;flex-direction:column}
    nav{height:64px;display:flex;align-items:center;border-bottom:1px solid #e8e5e0}
    .nav-inner{max-width:600px;margin:0 auto;width:100%;padding:0 clamp(20px,4vw,32px)}
    .nav-logo{font-family:'Outfit',sans-serif;font-size:26px;font-weight:700;letter-spacing:-.8px;color:#1a1a1a;text-decoration:none}
    .center{flex:1;display:flex;align-items:center;justify-content:center;text-align:center;padding:40px clamp(20px,4vw,32px)}
    .box{max-width:440px}
    .badge{font-family:'Outfit',sans-serif;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:2.5px;color:#1a1a1a;background:#efece6;display:inline-block;padding:6px 16px;border-radius:100px;margin-bottom:24px}
    h1{font-size:clamp(30px,5vw,46px);font-weight:400;line-height:1.1;letter-spacing:-1px;margin-bottom:16px}
    h1 em{font-style:italic}
    p{font-family:'Outfit',sans-serif;font-size:16px;color:#666;line-height:1.7;margin-bottom:28px}
    .btn{font-family:'Outfit',sans-serif;font-size:16px;font-weight:600;background:#1a1a1a;color:#faf9f6;border:none;padding:14px 32px;border-radius:100px;cursor:pointer;text-decoration:none;display:inline-block;transition:all .25s}
    .btn:hover{background:#333;transform:translateY(-2px);box-shadow:0 8px 30px rgba(0,0,0,.12)}
    footer{border-top:1px solid #e8e5e0}
    .footer-inner{max-width:600px;margin:0 auto;padding:28px clamp(20px,4vw,32px) 40px;display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}
    .footer-logo{font-family:'Outfit',sans-serif;font-size:16px;font-weight:700;letter-spacing:-.5px}
    .footer-links{display:flex;align-items:center;gap:20px;flex-wrap:wrap}
    .footer-link{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb;text-decoration:none;transition:color .15s}
    .footer-link:hover{color:#1a1a1a}
    .footer-copy{font-family:'Outfit',sans-serif;font-size:13px;color:#bbb}
  </style>
</head>
<body>
<nav><div class="nav-inner"><a href="https://suparade.com" class="nav-logo">Suparade</a></div></nav>
<div class="center">
  <div class="box">
    <div class="badge">You're in</div>
    <h1>Welcome aboard,<br><em>${firstName}.</em></h1>
    <p>We'll start building your lead list within 24 hours. Keep an eye on your inbox.</p>
    <a href="https://suparade.com" class="btn">Back to Suparade →</a>
  </div>
</div>
<footer>
  <div class="footer-inner">
    <div class="footer-logo">Suparade</div>
    <div class="footer-links">
      <a href="/terms" class="footer-link">Terms</a>
      <a href="/policy" class="footer-link">Policy</a>
      <span class="footer-copy">© 2026 Suparade.</span>
    </div>
  </div>
</footer>
</body>
</html>`;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

onboardingRouter.get('/', (_req, res) => {
  res.send(formPage());
});

onboardingRouter.post('/', express.urlencoded({ extended: false }), async (req, res) => {
  const name   = req.body.name?.trim();
  const email  = req.body.email?.trim().toLowerCase();
  const niches = Array.isArray(req.body.niche)
    ? req.body.niche
    : req.body.niche ? [req.body.niche] : [];
  const states = Array.isArray(req.body.states)
    ? req.body.states
    : req.body.states ? [req.body.states] : [];

  // Parse city targets submitted as hidden JSON inputs
  const rawCities = Array.isArray(req.body.target_city)
    ? req.body.target_city
    : req.body.target_city ? [req.body.target_city] : [];
  const cities = rawCities
    .map(v => { try { return JSON.parse(v); } catch { return null; } })
    .filter(c => c && c.zip && typeof c.miles === 'number');

  if (!name || !email || niches.length === 0 || (states.length === 0 && cities.length === 0)) {
    return res.send(formPage('Please complete all fields, select at least one niche, and choose target states or cities.', 2));
  }

  const { data: existing } = await supabase
    .from('clients')
    .select('id')
    .eq('email', email)
    .maybeSingle();

  if (existing) {
    const { error } = await supabase
      .from('clients')
      .update({
        name,
        target_niche:  niches,
        target_states: states,
        target_cities: cities.length ? cities : null,
      })
      .eq('id', existing.id);

    if (error) {
      console.error('[Onboarding] Update error:', error.message);
      return res.send(formPage('Something went wrong. Please try again.', 2));
    }
  } else {
    const { error } = await supabase.from('clients').insert({
      name, email,
      tier: 'starter',
      monthly_quota: TIER_QUOTAS.starter,
      target_niche:  niches,
      target_states: states,
      target_cities: cities.length ? cities : null,
    });

    if (error) {
      console.error('[Onboarding] Insert error:', error.message);
      return res.send(formPage('Something went wrong. Please try again.', 2));
    }
  }

  console.log(`[Onboarding] Setup complete: ${email}`);
  res.send(successPage(name.split(' ')[0]));
});

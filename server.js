'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'contact-submissions.jsonl');
const PARTNER_SUBMISSIONS_FILE = path.join(DATA_DIR, 'partner-submissions.jsonl');
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_BODY_SIZE = 64 * 1024;

const MIME_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.svg', 'image/svg+xml; charset=utf-8'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
]);

const CONTACT_CATEGORIES = new Set(['donor', 'volunteer', 'partner', 'student', 'media', 'other']);
const PARTNER_TYPES = new Set(['corporate', 'school', 'ngo', 'government', 'media', 'donor', 'other']);
const DONATION_PROGRAMS = new Set([
  'Scholarship Fund',
  'Youth Mentorship',
  'Digital Skills Lab',
  'Girls in STEM',
  'Rural Outreach',
  'Entrepreneurship Hub',
  'General Donation'
]);
const MPESA_PAYMENTS_FILE = path.join(DATA_DIR, 'mpesa-payments.jsonl');
const MPESA_CALLBACKS_FILE = path.join(DATA_DIR, 'mpesa-callbacks.jsonl');
const BANK_DONATIONS_FILE = path.join(DATA_DIR, 'bank-donations.jsonl');
const GATEWAY_DONATIONS_FILE = path.join(DATA_DIR, 'gateway-donations.jsonl');
const PAYMENT_METHODS = new Map([
  ['mpesa', { label: 'M-Pesa STK Push', type: 'mobile_money' }],
  ['bank', { label: 'Bank Transfer', type: 'bank' }],
  ['visa', { label: 'Visa', type: 'card' }],
  ['mastercard', { label: 'Mastercard', type: 'card' }],
  ['american_express', { label: 'American Express', type: 'card' }],
  ['paypal', { label: 'PayPal', type: 'wallet' }],
  ['google_pay', { label: 'Google Pay', type: 'wallet' }]
]);

function loadEnvFile() {
  try {
    const envPath = path.join(ROOT_DIR, '.env');
    const envFile = require('node:fs').readFileSync(envPath, 'utf8');
    envFile.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) return;
      const index = trimmed.indexOf('=');
      const key = trimmed.slice(0, index).trim();
      const rawValue = trimmed.slice(index + 1).trim();
      const value = rawValue.replace(/^['"]|['"]$/g, '');
      if (key && process.env[key] === undefined) process.env[key] = value;
    });
  } catch {
    // .env is optional; production hosts usually provide real environment variables.
  }
}

loadEnvFile();

const getDarajaBaseUrl = () => (
  process.env.DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke'
);

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function cleanText(value, maxLength) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function validateContactSubmission(payload) {
  const firstName = cleanText(payload.firstName, 80);
  const lastName = cleanText(payload.lastName, 80);
  const email = cleanText(payload.email, 160).toLowerCase();
  const category = cleanText(payload.category, 40);
  const message = cleanText(payload.message, 2500);
  const errors = {};

  if (!firstName) errors.firstName = 'First name is required.';
  if (!lastName) errors.lastName = 'Last name is required.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.email = 'A valid email address is required.';
  if (!CONTACT_CATEGORIES.has(category)) errors.category = 'Please choose a valid category.';
  if (message.length < 10) errors.message = 'Message must be at least 10 characters.';

  return {
    errors,
    data: { firstName, lastName, email, category, message }
  };
}

function validatePartnerSubmission(payload) {
  const organization = cleanText(payload.organization, 140);
  const contactName = cleanText(payload.contactName, 120);
  const email = cleanText(payload.partnerEmail, 160).toLowerCase();
  const phone = cleanText(payload.partnerPhone, 60);
  const partnerType = cleanText(payload.partnerType, 40);
  const interest = cleanText(payload.partnerInterest, 2500);
  const errors = {};

  if (!organization) errors.organization = 'Organization name is required.';
  if (!contactName) errors.contactName = 'Contact person is required.';
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) errors.partnerEmail = 'A valid email address is required.';
  if (!PARTNER_TYPES.has(partnerType)) errors.partnerType = 'Choose a partnership type.';
  if (interest.length < 20) errors.partnerInterest = 'Tell us a little more about the partnership.';

  return {
    errors,
    data: { organization, contactName, email, phone, partnerType, interest }
  };
}

function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (/^2547\d{8}$/.test(digits) || /^2541\d{8}$/.test(digits)) return digits;
  if (/^07\d{8}$/.test(digits) || /^01\d{8}$/.test(digits)) return `254${digits.slice(1)}`;
  if (/^7\d{8}$/.test(digits) || /^1\d{8}$/.test(digits)) return `254${digits}`;
  return '';
}

function validateMpesaPayment(payload) {
  const donorName = cleanText(payload.donorName, 120);
  const donorEmail = cleanText(payload.donorEmail, 160).toLowerCase();
  const program = cleanText(payload.program, 80);
  const note = cleanText(payload.note, 1000);
  const paymentMethod = cleanText(payload.paymentMethod || 'mpesa', 40);
  const phone = normalizeKenyanPhone(payload.phone);
  const amount = Math.round(Number(payload.amount));
  const accountReference = cleanText(
    payload.accountReference || process.env.MPESA_ACCOUNT_REFERENCE || program || 'NEXUS-DONATE',
    40
  );
  const transactionDesc = cleanText(
    payload.transactionDesc || process.env.MPESA_TRANSACTION_DESCRIPTION || `Donation to ${program || 'Unimatch Nexus Foundation'}`,
    100
  );
  const errors = {};

  if (!donorName) errors.donorName = 'Full name is required.';
  if (!donorEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(donorEmail)) errors.donorEmail = 'A valid email address is required.';
  if (!DONATION_PROGRAMS.has(program)) errors.program = 'Please choose the program you want to support.';
  if (!PAYMENT_METHODS.has(paymentMethod)) errors.paymentMethod = 'Choose a supported payment method.';
  if (paymentMethod === 'mpesa' && !phone) errors.phone = 'Use a valid Safaricom number, for example 07XXXXXXXX.';
  if (!Number.isFinite(amount) || amount < 1) errors.amount = 'Amount must be at least KES 1.';
  if (paymentMethod === 'mpesa' && amount > 150000) errors.amount = 'Amount cannot exceed the M-Pesa transaction limit.';

  return {
    errors,
    data: { donorName, donorEmail, program, note, paymentMethod, phone, amount, accountReference, transactionDesc }
  };
}

function getBankDetails() {
  return {
    bankName: process.env.BANK_NAME || 'Your Foundation Bank',
    accountName: process.env.BANK_ACCOUNT_NAME || 'Unimatch Nexus Foundation',
    accountNumber: process.env.BANK_ACCOUNT_NUMBER || 'Add account number in .env',
    branch: process.env.BANK_BRANCH || 'Add branch in .env',
    swiftCode: process.env.BANK_SWIFT_CODE || ''
  };
}

function getDarajaConfig() {
  return {
    consumerKey: process.env.DARAJA_CONSUMER_KEY,
    consumerSecret: process.env.DARAJA_CONSUMER_SECRET,
    shortcode: process.env.DARAJA_SHORTCODE,
    passkey: process.env.DARAJA_PASSKEY,
    callbackUrl: process.env.DARAJA_CALLBACK_URL,
    transactionType: process.env.DARAJA_TRANSACTION_TYPE || 'CustomerPayBillOnline'
  };
}

function getMissingDarajaConfig(config) {
  return Object.entries(config)
    .filter(([, value]) => !value)
    .map(([key]) => key);
}

function getGatewayPaymentUrl(paymentMethod) {
  if (paymentMethod === 'paypal') return process.env.PAYPAL_DONATE_URL || '';
  if (paymentMethod === 'google_pay') return process.env.GOOGLE_PAY_PAYMENT_URL || process.env.STRIPE_PAYMENT_LINK || '';
  if (['visa', 'mastercard', 'american_express'].includes(paymentMethod)) {
    return process.env.CARD_PAYMENT_URL || process.env.STRIPE_PAYMENT_LINK || '';
  }
  return '';
}

function getGatewaySetupHint(paymentMethod) {
  if (paymentMethod === 'paypal') return 'Add PAYPAL_DONATE_URL to .env to send donors to PayPal checkout.';
  if (paymentMethod === 'google_pay') return 'Connect Google Pay through a provider such as Stripe or Flutterwave, then set GOOGLE_PAY_PAYMENT_URL or STRIPE_PAYMENT_LINK.';
  return 'Connect a card processor such as Stripe, Flutterwave, Pesapal, or DPO, then set CARD_PAYMENT_URL or STRIPE_PAYMENT_LINK.';
}

function getPaymentMethodsPayload() {
  return [...PAYMENT_METHODS.entries()].map(([id, method]) => ({
    id,
    label: method.label,
    type: method.type,
    configured: id === 'mpesa'
      ? getMissingDarajaConfig(getDarajaConfig()).length === 0
      : id === 'bank' || Boolean(getGatewayPaymentUrl(id)),
    setupHint: id === 'mpesa'
      ? 'Configure Daraja keys in .env for live STK Push.'
      : id === 'bank'
        ? 'Configure bank account details in .env.'
        : getGatewaySetupHint(id)
  }));
}

function getDarajaTimestamp() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds())
  ].join('');
}

async function getDarajaAccessToken(config) {
  const credentials = Buffer.from(`${config.consumerKey}:${config.consumerSecret}`).toString('base64');
  let response;
  try {
    response = await fetch(`${getDarajaBaseUrl()}/oauth/v1/generate?grant_type=client_credentials`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${credentials}`
      }
    });
  } catch {
    throw Object.assign(new Error('Could not reach Safaricom Daraja. Check internet access and Daraja environment settings.'), {
      statusCode: 502
    });
  }
  const result = await response.json().catch(() => ({}));

  if (!response.ok || !result.access_token) {
    throw Object.assign(new Error(result.errorMessage || result.error_description || 'Could not get Daraja access token.'), {
      statusCode: 502,
      details: result
    });
  }

  return result.access_token;
}

async function appendJsonLine(filePath, record) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.appendFile(filePath, `${JSON.stringify(record)}\n`, 'utf8');
}

async function handleMpesaPayment(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: 'Method not allowed.' });
    return;
  }

  try {
    const rawBody = await readRequestBody(req);
    const payload = rawBody ? JSON.parse(rawBody) : {};
    const { errors, data } = validateMpesaPayment(payload);

    if (Object.keys(errors).length) {
      sendJson(res, 422, { ok: false, message: 'Please fix the payment details.', errors });
      return;
    }

    if (data.paymentMethod === 'bank') {
      const requestId = crypto.randomUUID();
      const bankDetails = getBankDetails();

      await appendJsonLine(BANK_DONATIONS_FILE, {
        id: requestId,
        createdAt: new Date().toISOString(),
        status: 'bank-transfer-pending',
        donorName: data.donorName,
        donorEmail: data.donorEmail,
        program: data.program,
        note: data.note,
        phone: data.phone,
        amount: data.amount,
        bankDetails
      });

      sendJson(res, 200, {
        ok: true,
        id: requestId,
        paymentMethod: 'bank',
        bankDetails,
        message: 'Thank you. Your bank transfer details have been recorded. Please use the bank details shown to complete your donation.'
      });
      return;
    }

    if (data.paymentMethod !== 'mpesa') {
      const requestId = crypto.randomUUID();
      const method = PAYMENT_METHODS.get(data.paymentMethod);
      const redirectUrl = getGatewayPaymentUrl(data.paymentMethod);
      const status = redirectUrl ? 'gateway-checkout-ready' : 'gateway-setup-required';

      await appendJsonLine(GATEWAY_DONATIONS_FILE, {
        id: requestId,
        createdAt: new Date().toISOString(),
        status,
        donorName: data.donorName,
        donorEmail: data.donorEmail,
        program: data.program,
        note: data.note,
        phone: data.phone,
        amount: data.amount,
        paymentMethod: data.paymentMethod,
        paymentLabel: method.label,
        redirectUrl: redirectUrl || null
      });

      sendJson(res, 200, {
        ok: true,
        id: requestId,
        paymentMethod: data.paymentMethod,
        paymentLabel: method.label,
        status,
        redirectUrl: redirectUrl || null,
        setupRequired: !redirectUrl,
        message: redirectUrl
          ? `Thank you. Continue to ${method.label} checkout to complete your donation.`
          : `Thank you. Your ${method.label} donation request has been recorded. ${getGatewaySetupHint(data.paymentMethod)}`
      });
      return;
    }

    const config = getDarajaConfig();
    const missingConfig = getMissingDarajaConfig(config);

    if (missingConfig.length) {
      sendJson(res, 500, {
        ok: false,
        message: 'Daraja is not configured yet. Add the missing values to .env.',
        missingConfig
      });
      return;
    }

    const timestamp = getDarajaTimestamp();
    const password = Buffer.from(`${config.shortcode}${config.passkey}${timestamp}`).toString('base64');
    const token = await getDarajaAccessToken(config);
    const requestId = crypto.randomUUID();
    const stkPayload = {
      BusinessShortCode: config.shortcode,
      Password: password,
      Timestamp: timestamp,
      TransactionType: config.transactionType,
      Amount: data.amount,
      PartyA: data.phone,
      PartyB: config.shortcode,
      PhoneNumber: data.phone,
      CallBackURL: config.callbackUrl,
      AccountReference: data.accountReference,
      TransactionDesc: data.transactionDesc
    };

    let response;
    try {
      response = await fetch(`${getDarajaBaseUrl()}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(stkPayload)
      });
    } catch {
      throw Object.assign(new Error('Could not reach Safaricom Daraja. Check internet access and Daraja environment settings.'), {
        statusCode: 502
      });
    }
    const result = await response.json().catch(() => ({}));
    const accepted = response.ok && (result.ResponseCode === '0' || result.responseCode === '0');

    await appendJsonLine(MPESA_PAYMENTS_FILE, {
      id: requestId,
      createdAt: new Date().toISOString(),
      accepted,
      donorName: data.donorName,
      donorEmail: data.donorEmail,
      program: data.program,
      note: data.note,
      paymentMethod: data.paymentMethod,
      phone: data.phone,
      amount: data.amount,
      accountReference: data.accountReference,
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      darajaResponse: result
    });

    if (!accepted) {
      sendJson(res, 502, {
        ok: false,
        message: result.errorMessage || result.ResponseDescription || 'M-Pesa could not start the payment request.',
        darajaResponse: result
      });
      return;
    }

    sendJson(res, 200, {
      ok: true,
      id: requestId,
      checkoutRequestId: result.CheckoutRequestID,
      merchantRequestId: result.MerchantRequestID,
      message: 'Check your phone and enter your M-Pesa PIN to complete the donation.'
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { ok: false, message: 'Invalid JSON request.' });
      return;
    }

    sendJson(res, error.statusCode || 500, {
      ok: false,
      message: error.message || 'Unable to start M-Pesa payment. Please try again shortly.'
    });
  }
}

async function handleMpesaCallback(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: 'Method not allowed.' });
    return;
  }

  try {
    const rawBody = await readRequestBody(req);
    let payload = {};
    try {
      payload = rawBody ? JSON.parse(rawBody) : {};
    } catch {
      payload = { rawBody };
    }
    await appendJsonLine(MPESA_CALLBACKS_FILE, {
      id: crypto.randomUUID(),
      receivedAt: new Date().toISOString(),
      payload
    });
    sendJson(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
  } catch {
    sendJson(res, 200, { ResultCode: 0, ResultDesc: 'Accepted' });
  }
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];

    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(Object.assign(new Error('Request body is too large.'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleContact(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: 'Method not allowed.' });
    return;
  }

  try {
    const rawBody = await readRequestBody(req);
    const payload = rawBody ? JSON.parse(rawBody) : {};
    const { errors, data } = validateContactSubmission(payload);

    if (Object.keys(errors).length) {
      sendJson(res, 422, { ok: false, message: 'Please fix the highlighted fields.', errors });
      return;
    }

    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      source: 'website-contact-form',
      ...data
    };

    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.appendFile(SUBMISSIONS_FILE, `${JSON.stringify(record)}\n`, 'utf8');

    sendJson(res, 201, {
      ok: true,
      id: record.id,
      message: 'Thank you. Your message has been received and our team will contact you shortly.'
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { ok: false, message: 'Invalid JSON request.' });
      return;
    }

    sendJson(res, error.statusCode || 500, {
      ok: false,
      message: error.statusCode === 413 ? error.message : 'Something went wrong. Please try again shortly.'
    });
  }
}

async function handlePartner(req, res) {
  if (req.method !== 'POST') {
    sendJson(res, 405, { ok: false, message: 'Method not allowed.' });
    return;
  }

  try {
    const rawBody = await readRequestBody(req);
    const payload = rawBody ? JSON.parse(rawBody) : {};
    const { errors, data } = validatePartnerSubmission(payload);

    if (Object.keys(errors).length) {
      sendJson(res, 422, { ok: false, message: 'Please fix the partnership form.', errors });
      return;
    }

    const record = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      source: 'website-partner-form',
      ...data
    };

    await appendJsonLine(PARTNER_SUBMISSIONS_FILE, record);

    sendJson(res, 201, {
      ok: true,
      id: record.id,
      message: 'Thank you. Your partnership request has been received and our team will contact you shortly.'
    });
  } catch (error) {
    if (error instanceof SyntaxError) {
      sendJson(res, 400, { ok: false, message: 'Invalid JSON request.' });
      return;
    }

    sendJson(res, error.statusCode || 500, {
      ok: false,
      message: error.statusCode === 413 ? error.message : 'Something went wrong. Please try again shortly.'
    });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const requestedPath = path.resolve(ROOT_DIR, `.${pathname}`);
  const relativePath = path.relative(ROOT_DIR, requestedPath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  try {
    const file = await fs.readFile(requestedPath);
    const contentType = MIME_TYPES.get(path.extname(requestedPath).toLowerCase()) || 'application/octet-stream';
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': pathname === '/index.html' ? 'no-cache' : 'public, max-age=3600'
    });
    res.end(file);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function createServer() {
  return http.createServer(async (req, res) => {
    if (req.url === '/api/health') {
      const missingDarajaConfig = getMissingDarajaConfig(getDarajaConfig());
      sendJson(res, 200, {
        ok: true,
        service: 'unimatch-nexus-backend',
        daraja: {
          environment: process.env.DARAJA_ENV === 'production' ? 'production' : 'sandbox',
          configured: missingDarajaConfig.length === 0,
          missingConfig: missingDarajaConfig
        },
        paymentMethods: getPaymentMethodsPayload()
      });
      return;
    }

    if (req.url === '/api/payment-methods') {
      sendJson(res, 200, {
        ok: true,
        paymentMethods: getPaymentMethodsPayload()
      });
      return;
    }

    if (req.url === '/api/contact') {
      await handleContact(req, res);
      return;
    }

    if (req.url === '/api/partner') {
      await handlePartner(req, res);
      return;
    }

    if (req.url === '/api/donate' || req.url === '/api/mpesa/stk-push') {
      await handleMpesaPayment(req, res);
      return;
    }

    if (req.url === '/api/mpesa/callback') {
      await handleMpesaCallback(req, res);
      return;
    }

    await serveStatic(req, res);
  });
}

function startServer(port = PORT, host = HOST) {
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`Unimatch Nexus website running at http://${host}:${port}/`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createServer, startServer };

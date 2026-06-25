'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, 'data');
const SUBMISSIONS_FILE = path.join(DATA_DIR, 'contact-submissions.jsonl');
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
      sendJson(res, 200, { ok: true, service: 'unimatch-nexus-backend' });
      return;
    }

    if (req.url === '/api/contact') {
      await handleContact(req, res);
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

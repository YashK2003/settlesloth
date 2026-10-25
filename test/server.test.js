'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const app = require('../server');

let server;
let baseUrl;

before(async () => {
  server = app.listen(0, '127.0.0.1');

  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}`;
});

after(async () => {
  if (!server) return;

  server.closeAllConnections?.();

  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
});

test('GET /api/health returns a healthy status', async () => {
  const response = await fetch(`${baseUrl}/api/health`);

  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(data.status, 'ok');
  assert.equal(data.service, 'settlesloth');
  assert.deepEqual(data.openWeightModels, ['gemma-4-26b-a4b-it', 'gemma-4-31b-it', 'gemma3:4b', 'gemma3:1b']);
  assert.ok(data.providerConfigured);
});

test('GET / returns the landing message', async () => {
  const response = await fetch(`${baseUrl}/`);

  assert.equal(response.status, 200);

  const body = await response.text();

  assert.match(body, /SettleSloth is running/);
  assert.match(body, /\/api\/health/);
});

test('Unknown routes return a JSON 404', async () => {
  const response = await fetch(`${baseUrl}/api/does-not-exist`);

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), {
    error: 'Not Found',
    path: '/api/does-not-exist'
  });
});

test('Malformed JSON returns a 400 error', async () => {
  const response = await fetch(`${baseUrl}/api/unknown`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{"malformed": json}'
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: 'Invalid JSON body'
  });
});

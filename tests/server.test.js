const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../server');

async function requestJson(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) };
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    payload = text;
  }

  return { status: response.status, payload };
}

async function withServer(callback) {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  try {
    return await callback({ port: address.port });
  } finally {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
}

test('GET /api/state returns the seeded learning data', async () => {
  await withServer(async ({ port }) => {
    const { status, payload } = await requestJson(`http://127.0.0.1:${port}/api/state`);
    assert.equal(status, 200);
    assert.equal(payload.institution.name, 'VFU E-Learning Classroom');
    assert.ok(Array.isArray(payload.courses));
    assert.ok(Array.isArray(payload.assignments));
  });
});

test('POST /api/submissions requires a signed-in session', async () => {
  await withServer(async ({ port }) => {
    const { status, payload } = await requestJson(`http://127.0.0.1:${port}/api/submissions`, {
      method: 'POST',
      body: { assignmentId: 'assignment-api', userId: 'u-student-1', text: 'Some work' }
    });

    assert.equal(status, 401);
    assert.match(payload.error, /sign in/i);
  });
});

test('POST /api/login rejects an incorrect password', async () => {
  await withServer(async ({ port }) => {
    const { status, payload } = await requestJson(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      body: { role: 'student', email: 'student@vfu.local', password: 'wrong-password' }
    });

    assert.equal(status, 401);
    assert.match(payload.error, /incorrect/i);
  });
});

test('POST /api/submissions rejects empty submission text once authenticated', async () => {
  await withServer(async ({ port }) => {
    const login = await requestJson(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      body: { role: 'student', email: 'student@vfu.local', password: 'student123' }
    });
    assert.equal(login.status, 200);
    assert.ok(login.payload.token);

    const { status, payload } = await requestJson(`http://127.0.0.1:${port}/api/submissions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${login.payload.token}` },
      body: { assignmentId: 'assignment-api', userId: 'u-student-1', text: '   ' }
    });

    assert.equal(status, 400);
    assert.match(payload.error, /submission text/i);
  });
});

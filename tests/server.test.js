const test = require('node:test');
const { before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createServer } = require('../server');

// The server persists to the real JSON data file; snapshot it so the
// mutation tests below (sessions, assignments, study rooms) leave no trace.
const DATA_FILE = path.join(__dirname, '..', 'data', 'vfu-data.json');
let dataSnapshot = null;
before(() => { dataSnapshot = fs.existsSync(DATA_FILE) ? fs.readFileSync(DATA_FILE, 'utf8') : null; });
after(() => { if (dataSnapshot !== null) fs.writeFileSync(DATA_FILE, dataSnapshot, 'utf8'); });

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

async function login(port, role, email, password) {
  const { status, payload } = await requestJson(`http://127.0.0.1:${port}/api/login`, {
    method: 'POST',
    body: { role, email, password }
  });
  assert.equal(status, 200);
  return payload.token;
}

test('students cannot start live classes or create assignments', async () => {
  await withServer(async ({ port }) => {
    const token = await login(port, 'student', 'student@vfu.local', 'student123');
    const headers = { authorization: `Bearer ${token}` };

    const start = await requestJson(`http://127.0.0.1:${port}/api/sessions/start`, {
      method: 'POST', headers, body: { courseId: 'course-web' }
    });
    assert.equal(start.status, 403);

    const assignment = await requestJson(`http://127.0.0.1:${port}/api/assignments`, {
      method: 'POST', headers, body: { courseId: 'course-web', title: 'Hack attempt' }
    });
    assert.equal(assignment.status, 403);
  });
});

test('live class flow: start, join marks present, end marks missing students absent', async () => {
  await withServer(async ({ port }) => {
    const lecturerToken = await login(port, 'lecturer', 'lecturer@vfu.local', 'lecturer123');
    const studentToken = await login(port, 'student', 'student@vfu.local', 'student123');

    const start = await requestJson(`http://127.0.0.1:${port}/api/sessions/start`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lecturerToken}` },
      body: { courseId: 'course-web', title: 'Test live class', duration: 45 }
    });
    assert.equal(start.status, 201);
    const sessionId = start.payload.session.id;
    assert.equal(start.payload.session.status, 'Live');

    const join = await requestJson(`http://127.0.0.1:${port}/api/sessions/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${studentToken}` },
      body: { sessionId }
    });
    assert.equal(join.status, 200);
    assert.ok(join.payload.attendance.some(
      (item) => item.sessionId === sessionId && item.userId === 'u-student-1' && item.status === 'Present'
    ));

    const end = await requestJson(`http://127.0.0.1:${port}/api/sessions/end`, {
      method: 'POST',
      headers: { authorization: `Bearer ${lecturerToken}` },
      body: { sessionId }
    });
    assert.equal(end.status, 200);
    assert.equal(end.payload.session.status, 'Ended');

    // u-student-1 joined, so stays Present. u-student-2 is in the Business
    // field, so the ICT class never applies to them: no absent record.
    const records = end.payload.attendance.filter((item) => item.sessionId === sessionId);
    assert.equal(records.filter((item) => item.userId === 'u-student-1' && item.status === 'Present').length, 1);
    assert.equal(records.filter((item) => item.userId === 'u-student-2').length, 0);
  });
});

test('study rooms enforce the course field: business student cannot join an ICT room', async () => {
  await withServer(async ({ port }) => {
    const ictToken = await login(port, 'student', 'student@vfu.local', 'student123');
    const businessToken = await login(port, 'student', 'bwalya@vfu.local', 'student123');

    const created = await requestJson(`http://127.0.0.1:${port}/api/studyrooms`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ictToken}` },
      body: { courseId: 'course-web', topic: 'Week 4 revision' }
    });
    assert.equal(created.status, 201);

    const joined = await requestJson(`http://127.0.0.1:${port}/api/studyrooms/join`, {
      method: 'POST',
      headers: { authorization: `Bearer ${businessToken}` },
      body: { roomId: created.payload.room.id }
    });
    assert.equal(joined.status, 403);
  });
});

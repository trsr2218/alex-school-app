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

// The Phase 1 tests below share one server and log in once per role, reusing
// those tokens across every assertion (rather than withServer()+login() per
// test) because /api/login is IP rate-limited to 10 attempts per 5 minutes —
// fresh logins per test would trip that limit long before reaching these.
let phase1Server = null;
let phase1Port = null;
const phase1Tokens = {};

before(async () => {
  phase1Server = createServer();
  await new Promise((resolve) => phase1Server.listen(0, '127.0.0.1', resolve));
  phase1Port = phase1Server.address().port;
  phase1Tokens.student = await login(phase1Port, 'student', 'student@vfu.local', 'student123');
  phase1Tokens.lecturer = await login(phase1Port, 'lecturer', 'lecturer@vfu.local', 'lecturer123');
  phase1Tokens.admin = await login(phase1Port, 'admin', 'admin@vfu.local', 'admin123');
});

after(async () => {
  await new Promise((resolve, reject) => phase1Server.close((error) => (error ? reject(error) : resolve())));
});

test('a student cannot self-provision a lecturer or admin account', async () => {
  const attempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { name: 'Hacker Lecturer', email: `hacker-${Date.now()}@vfu.local`, password: 'password1', role: 'lecturer' }
  });
  assert.equal(attempt.status, 403);
});

test('admin can provision a lecturer account', async () => {
  const email = `new-lecturer-${Date.now()}@vfu.local`;
  const created = await requestJson(`http://127.0.0.1:${phase1Port}/api/admin/users`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { name: 'New Lecturer', email, password: 'password1', role: 'lecturer' }
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.user.role, 'lecturer');
});

test('PATCH /api/users/:id is admin-only and is the sole way to change a role', async () => {
  const selfPromote = await requestJson(`http://127.0.0.1:${phase1Port}/api/users/u-student-1`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { role: 'admin' }
  });
  assert.equal(selfPromote.status, 403);

  const promote = await requestJson(`http://127.0.0.1:${phase1Port}/api/users/u-student-2`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { role: 'lecturer' }
  });
  assert.equal(promote.status, 200);
  assert.equal(promote.payload.user.role, 'lecturer');

  // Demote back so this test leaves no lasting trace beyond the JSON snapshot restore.
  await requestJson(`http://127.0.0.1:${phase1Port}/api/users/u-student-2`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { role: 'student' }
  });
});

test('a lecturer can only edit/reassign courses they own', async () => {
  // course-fin is owned by u-lecturer-1 in the seed data, so this should succeed...
  const ownEdit = await requestJson(`http://127.0.0.1:${phase1Port}/api/courses/course-fin`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { room: 'Virtual Room D' }
  });
  assert.equal(ownEdit.status, 200);

  // ...but a course owned by someone else must be rejected (no login needed to prove
  // this: admin creates a course assigned to u-admin-1, then u-lecturer-1 tries to edit it).
  const otherCourse = await requestJson(`http://127.0.0.1:${phase1Port}/api/courses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { code: `Y${Date.now()}`, title: 'Admin-owned course', lecturerId: 'u-admin-1' }
  });
  assert.equal(otherCourse.status, 201);

  const otherEdit = await requestJson(`http://127.0.0.1:${phase1Port}/api/courses/${otherCourse.payload.course.id}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { room: 'Hijacked Room' }
  });
  assert.equal(otherEdit.status, 403);
});

test('strict program access denies a course with no matching programId (no more universal-access fallback)', async () => {
  const program = await requestJson(`http://127.0.0.1:${phase1Port}/api/programs`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { name: 'Unmapped Program', code: `UNMAPPED-${Date.now()}` }
  });
  assert.equal(program.status, 201);

  const course = await requestJson(`http://127.0.0.1:${phase1Port}/api/courses`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { code: `X${Date.now()}`, title: 'Orphan course', programId: program.payload.program.id }
  });
  assert.equal(course.status, 201);

  // u-student-1 is prog-ict, the new course is a different program: must be denied,
  // not silently allowed the way the old regex heuristic would allow an unmatched field.
  const joinAttempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/studyrooms`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { courseId: course.payload.course.id, topic: 'Should be denied' }
  });
  assert.equal(joinAttempt.status, 403);
});

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
      body: { sessionId, studentNumber: 'VFU-ST-2026-001' }
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

// Phase 2A tests below reuse the same shared server/tokens as the Phase 1 tests above.

test('announcements, tutorials, and materials are staff-only to create', async () => {
  const announceAttempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/announcements`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { title: 'Hack attempt', eventAt: new Date(Date.now() + 86400000).toISOString(), audienceType: 'all' }
  });
  assert.equal(announceAttempt.status, 403);

  const announceOk = await requestJson(`http://127.0.0.1:${phase1Port}/api/announcements`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { title: 'Registration deadline', eventAt: new Date(Date.now() + 86400000).toISOString(), audienceType: 'all' }
  });
  assert.equal(announceOk.status, 201);

  const tutorialAttempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/tutorials`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { title: 'Hack attempt', videoUrl: 'https://example.com/video', programId: 'prog-ict' }
  });
  assert.equal(tutorialAttempt.status, 403);

  const tutorialOk = await requestJson(`http://127.0.0.1:${phase1Port}/api/tutorials`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { title: 'Intro to networking', videoUrl: 'https://example.com/video', programId: 'prog-ict' }
  });
  assert.equal(tutorialOk.status, 201);

  const materialAttempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/materials`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { title: 'Hack attempt', programId: 'prog-ict', fileName: 'notes.txt', fileData: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}` }
  });
  assert.equal(materialAttempt.status, 403);

  const materialOk = await requestJson(`http://127.0.0.1:${phase1Port}/api/materials`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.admin}` },
    body: { title: 'Week 1 slides', programId: 'prog-ict', fileName: 'slides.txt', fileData: `data:text/plain;base64,${Buffer.from('hi').toString('base64')}` }
  });
  assert.equal(materialOk.status, 201);
});

test('scheduling a live class requires a future date, and a scheduled session can be begun (Scheduled -> Live)', async () => {
  const pastAttempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/schedule`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { courseId: 'course-net', title: 'Past class', startsAt: new Date(Date.now() - 86400000).toISOString() }
  });
  assert.equal(pastAttempt.status, 400);

  const scheduled = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/schedule`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { courseId: 'course-net', title: 'Future class', startsAt: new Date(Date.now() + 86400000).toISOString() }
  });
  assert.equal(scheduled.status, 201);
  assert.equal(scheduled.payload.session.status, 'Scheduled');

  const begun = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/begin`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { sessionId: scheduled.payload.session.id }
  });
  assert.equal(begun.status, 200);
  assert.equal(begun.payload.session.status, 'Live');

  // Clean up so this Live session doesn't linger and interfere with other tests.
  await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/end`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { sessionId: scheduled.payload.session.id }
  });
});

test('joining a live class with the wrong student number is rejected', async () => {
  const start = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { courseId: 'course-db', title: 'Student number check' }
  });
  assert.equal(start.status, 201);
  const sessionId = start.payload.session.id;

  const wrongNumber = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/join`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { sessionId, studentNumber: 'WRONG-NUMBER' }
  });
  assert.equal(wrongNumber.status, 403);

  const correctNumber = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/join`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { sessionId, studentNumber: 'VFU-ST-2026-001' }
  });
  assert.equal(correctNumber.status, 200);

  await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/end`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { sessionId }
  });
});

// Phase 2B tests below also reuse the shared server/tokens from Phase 1 (no fresh logins).

test('WebSocket handshake rejects a connection with no token or an invalid token', async () => {
  const attempt = (query) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${phase1Port}/ws${query}`);
    const finish = (outcome) => { try { ws.close(); } catch {} resolve(outcome); };
    ws.addEventListener('open', () => finish('open'));
    ws.addEventListener('error', () => finish('error'));
  });

  assert.equal(await attempt(''), 'error');
  assert.equal(await attempt('?token=not-a-real-token'), 'error');
});

test('WebSocket handshake rejects joining a channel that does not exist', async () => {
  // Reuses an already-issued token (no fresh login) since /api/login is rate-limited
  // and this file's total login budget is already tight — see the comment above.
  const outcome = await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${phase1Port}/ws?token=${phase1Tokens.student}&channel=session-does-not-exist`);
    const finish = (result) => { try { ws.close(); } catch {} resolve(result); };
    ws.addEventListener('open', () => finish('open'));
    ws.addEventListener('error', () => finish('error'));
  });
  assert.equal(outcome, 'error');
});

test('a chat message sent by one WebSocket client is broadcast to a second client in the same channel', async () => {
  const start = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { courseId: 'course-net', title: 'WS broadcast test' }
  });
  assert.equal(start.status, 201);
  const sessionId = start.payload.session.id;

  const wsA = new WebSocket(`ws://127.0.0.1:${phase1Port}/ws?token=${phase1Tokens.lecturer}&channel=${sessionId}`);
  const wsB = new WebSocket(`ws://127.0.0.1:${phase1Port}/ws?token=${phase1Tokens.student}&channel=${sessionId}`);

  await Promise.all([
    new Promise((resolve, reject) => { wsA.addEventListener('open', resolve); wsA.addEventListener('error', reject); }),
    new Promise((resolve, reject) => { wsB.addEventListener('open', resolve); wsB.addEventListener('error', reject); })
  ]);

  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for broadcast')), 4000);
    wsB.addEventListener('message', (event) => { clearTimeout(timer); resolve(JSON.parse(event.data)); });
  });

  wsA.send(JSON.stringify({ type: 'chat', channel: sessionId, payload: { text: 'hello room' } }));
  const message = await received;

  assert.equal(message.type, 'chat');
  assert.equal(message.payload.text, 'hello room');
  assert.equal(message.from.role, 'lecturer');

  wsA.close(); wsB.close();
  await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/end`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { sessionId }
  });
});

test('presentations: staff-only to create, host-only to update, slide index is validated', async () => {
  const start = await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/start`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { courseId: 'course-fin', title: 'Presentation test session' }
  });
  assert.equal(start.status, 201);
  const sessionId = start.payload.session.id;
  const slide = { dataUrl: `data:image/png;base64,${Buffer.from('slide').toString('base64')}` };

  const studentAttempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/presentations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { title: 'Hack deck', sessionId, slides: [slide] }
  });
  assert.equal(studentAttempt.status, 403);

  const created = await requestJson(`http://127.0.0.1:${phase1Port}/api/presentations`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { title: 'Week 5 slides', sessionId, slides: [slide, slide] }
  });
  assert.equal(created.status, 201);
  assert.equal(created.payload.presentation.slides.length, 2);
  const presentationId = created.payload.presentation.id;

  const outOfRange = await requestJson(`http://127.0.0.1:${phase1Port}/api/presentations/${presentationId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { currentIndex: 5 }
  });
  assert.equal(outOfRange.status, 400);

  const validUpdate = await requestJson(`http://127.0.0.1:${phase1Port}/api/presentations/${presentationId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { currentIndex: 1 }
  });
  assert.equal(validUpdate.status, 200);
  assert.equal(validUpdate.payload.presentation.currentIndex, 1);

  await requestJson(`http://127.0.0.1:${phase1Port}/api/sessions/end`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { sessionId }
  });
});

test('messages: identity-checked sending, GET returns only the caller\'s own messages, only the recipient can mark read', async () => {
  const spoofAttempt = await requestJson(`http://127.0.0.1:${phase1Port}/api/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { senderId: 'u-lecturer-1', recipientId: 'u-student-1', text: 'spoofed' }
  });
  assert.equal(spoofAttempt.status, 403);

  const sent = await requestJson(`http://127.0.0.1:${phase1Port}/api/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { senderId: 'u-lecturer-1', recipientId: 'u-student-1', text: 'Office hours moved to 3pm.' }
  });
  assert.equal(sent.status, 201);
  const messageId = sent.payload.message.id;

  const studentInbox = await requestJson(`http://127.0.0.1:${phase1Port}/api/messages`, {
    headers: { authorization: `Bearer ${phase1Tokens.student}` }
  });
  assert.equal(studentInbox.status, 200);
  assert.ok(studentInbox.payload.messages.some((item) => item.id === messageId));

  const adminInbox = await requestJson(`http://127.0.0.1:${phase1Port}/api/messages`, {
    headers: { authorization: `Bearer ${phase1Tokens.admin}` }
  });
  assert.equal(adminInbox.status, 200);
  assert.ok(!adminInbox.payload.messages.some((item) => item.id === messageId));

  const wrongReader = await requestJson(`http://127.0.0.1:${phase1Port}/api/messages/${messageId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.lecturer}` },
    body: { read: true }
  });
  assert.equal(wrongReader.status, 403);

  const markRead = await requestJson(`http://127.0.0.1:${phase1Port}/api/messages/${messageId}`, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${phase1Tokens.student}` },
    body: { read: true }
  });
  assert.equal(markRead.status, 200);
  assert.equal(markRead.payload.message.read, true);
});

// ---------------------------------------------------------------------------
// Phase 3: no data and no accounts for callers who are not signed in.
// ---------------------------------------------------------------------------

test('GET /api/state hides the user directory and course data from signed-out callers', async () => {
  const signedOut = await requestJson(`http://127.0.0.1:${phase1Port}/api/state`);
  assert.equal(signedOut.status, 200);
  assert.equal(signedOut.payload.authenticated, false);
  // The login screen still needs these two.
  assert.equal(signedOut.payload.institution.name, 'VFU E-Learning Classroom');
  assert.ok(signedOut.payload.programs.length > 0);
  // Nothing else leaks: no accounts to enumerate, no course or submission data.
  assert.deepEqual(signedOut.payload.users, []);
  assert.deepEqual(signedOut.payload.courses, []);
  assert.deepEqual(signedOut.payload.submissions, []);
  assert.equal(JSON.stringify(signedOut.payload).includes('passwordHash'), false);

  const signedIn = await requestJson(`http://127.0.0.1:${phase1Port}/api/state`, {
    headers: { authorization: `Bearer ${phase1Tokens.student}` }
  });
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.payload.authenticated, true);
  assert.ok(signedIn.payload.users.length > 0);
  assert.equal(JSON.stringify(signedIn.payload).includes('passwordHash'), false);
  assert.equal(signedIn.payload.sessions, undefined);
});

test('GET /api/state treats a forged or expired bearer token as signed out', async () => {
  const forged = await requestJson(`http://127.0.0.1:${phase1Port}/api/state`, {
    headers: { authorization: 'Bearer not-a-real-token' }
  });
  assert.equal(forged.status, 200);
  assert.equal(forged.payload.authenticated, false);
  assert.deepEqual(forged.payload.users, []);
});

test('public signup cannot claim a role and cannot create an unassigned account', async () => {
  await withServer(async ({ port }) => {
    const programs = await requestJson(`http://127.0.0.1:${port}/api/state`);
    const programId = programs.payload.programs[0].id;

    // A caller asking for "admin" gets a student, never an administrator.
    const escalation = await requestJson(`http://127.0.0.1:${port}/api/signup`, {
      method: 'POST',
      body: { name: 'Role Climber', email: `climber-${Date.now()}@vfu.local`, password: 'password1', role: 'admin', programId, studentNumber: 'VFU-ST-2026-900' }
    });
    assert.equal(escalation.status, 201);
    assert.equal(escalation.payload.user.role, 'student');

    // Registration without a program (or without a student number) is refused
    // rather than creating an unassigned account.
    const unassigned = await requestJson(`http://127.0.0.1:${port}/api/signup`, {
      method: 'POST',
      body: { name: 'No Program', email: `noprogram-${Date.now()}@vfu.local`, password: 'password1', studentNumber: 'VFU-ST-2026-901' }
    });
    assert.equal(unassigned.status, 400);
    assert.match(unassigned.payload.error, /program/i);

    const noStudentNumber = await requestJson(`http://127.0.0.1:${port}/api/signup`, {
      method: 'POST',
      body: { name: 'No Number', email: `nonumber-${Date.now()}@vfu.local`, password: 'password1', programId }
    });
    assert.equal(noStudentNumber.status, 400);
    assert.match(noStudentNumber.payload.error, /student number/i);
  });
});

test('login refuses an unregistered email and refuses a real account under the wrong role', async () => {
  await withServer(async ({ port }) => {
    const unregistered = await requestJson(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      body: { role: 'admin', email: 'nobody@vfu.local', password: 'admin123' }
    });
    assert.equal(unregistered.status, 401);
    assert.equal(unregistered.payload.token, undefined);

    // A genuine student account cannot be used to sign in as an administrator.
    const wrongRole = await requestJson(`http://127.0.0.1:${port}/api/login`, {
      method: 'POST',
      body: { role: 'admin', email: 'student@vfu.local', password: 'student123' }
    });
    assert.equal(wrongRole.status, 401);
    assert.equal(wrongRole.payload.token, undefined);
  });
});

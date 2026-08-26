// The offline shim in public/app.js is a real auth boundary, not a bypass: it
// is what answers /api/* when the page is opened from file:// or hosted on a
// static host with no Node backend. These tests run that IIFE (and nothing else
// from app.js) inside a VM with the handful of browser globals it touches.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');

function loadShim() {
  const appSource = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
  const stateSource = fs.readFileSync(path.join(ROOT, 'public', 'state.js'), 'utf8');

  const end = appSource.indexOf('\n})();');
  if (end < 0) throw new Error('could not find the end of the offline IIFE in public/app.js');
  const shimSource = appSource.slice(0, end + '\n})();'.length);

  const store = new Map();
  const sandbox = {
    console,
    TextEncoder,
    Response,
    URLSearchParams,
    JSON,
    Math,
    Date,
    Object,
    Array,
    String,
    Number,
    Boolean,
    RegExp,
    Uint8Array,
    Uint32Array,
    DataView,
    Map,
    Set,
    crypto,
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key)
    },
    fetch: async () => { throw new Error('the harness has no network'); }
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.location = { protocol: 'file:' };

  vm.createContext(sandbox);
  vm.runInContext(stateSource, sandbox);
  vm.runInContext(shimSource, sandbox);

  return async function call(url, { method = 'GET', body, token } = {}) {
    const options = { method, headers: { 'content-type': 'application/json' } };
    if (token) options.headers.authorization = `Bearer ${token}`;
    if (body) options.body = JSON.stringify(body);
    const response = await sandbox.fetch(url, options);
    return { status: response.status, payload: await response.json() };
  };
}

async function signIn(call, role, email, password) {
  const result = await call('/api/login', { method: 'POST', body: { role, email, password } });
  assert.equal(result.status, 200, `${email} should have signed in`);
  return result.payload.token;
}

test('offline login refuses anyone who is not a registered account', async () => {
  const call = loadShim();

  // Each of these used to succeed: the old shim fell back to "the first user
  // with this role", then to data.users[0] — so any email at all signed you in,
  // as the administrator if that was the role picked.
  const unregistered = await call('/api/login', { method: 'POST', body: { role: 'admin', email: 'ghost@nowhere.test', password: 'whatever' } });
  assert.equal(unregistered.status, 401);
  assert.equal(unregistered.payload.token, undefined);

  const blank = await call('/api/login', { method: 'POST', body: { role: 'admin', email: '', password: '' } });
  assert.equal(blank.status, 401);

  const wrongRole = await call('/api/login', { method: 'POST', body: { role: 'admin', email: 'student@vfu.local', password: 'student123' } });
  assert.equal(wrongRole.status, 401);

  const wrongPassword = await call('/api/login', { method: 'POST', body: { role: 'admin', email: 'admin@vfu.local', password: 'admin124' } });
  assert.equal(wrongPassword.status, 401);

  const good = await call('/api/login', { method: 'POST', body: { role: 'admin', email: 'admin@vfu.local', password: 'admin123' } });
  assert.equal(good.status, 200);
  assert.ok(good.payload.token);
  assert.equal(good.payload.user.passwordHash, undefined);
});

test('offline state is empty without a session and complete with one', async () => {
  const call = loadShim();
  const token = await signIn(call, 'admin', 'admin@vfu.local', 'admin123');

  const anonymous = await call('/api/state');
  assert.equal(anonymous.payload.authenticated, false);
  assert.deepEqual(anonymous.payload.users, []);
  assert.deepEqual(anonymous.payload.courses, []);
  assert.ok(anonymous.payload.programs.length > 0, 'the signup form still needs the program list');

  const forged = await call('/api/state', { token: 'offline-forged-token' });
  assert.equal(forged.payload.authenticated, false);
  assert.deepEqual(forged.payload.users, []);

  const authenticated = await call('/api/state', { token });
  assert.equal(authenticated.payload.authenticated, true);
  assert.ok(authenticated.payload.users.length > 0);
  assert.equal(authenticated.payload.sessions, undefined);
  assert.equal(JSON.stringify(authenticated.payload).includes('passwordHash'), false);
});

test('offline writes require a session, respect roles, and take identity from the token', async () => {
  const call = loadShim();
  const studentToken = await signIn(call, 'student', 'student@vfu.local', 'student123');

  const anonymousWrite = await call('/api/courses', { method: 'POST', body: { code: 'HACK101', title: 'Injected' } });
  assert.equal(anonymousWrite.status, 401);

  const studentWrite = await call('/api/courses', { method: 'POST', token: studentToken, body: { code: 'HACK101', title: 'Injected' } });
  assert.equal(studentWrite.status, 403);

  const selfPromote = await call('/api/admin/users', {
    method: 'POST',
    token: studentToken,
    body: { name: 'Hacker', email: 'hacker@vfu.local', password: 'password1', role: 'admin' }
  });
  assert.equal(selfPromote.status, 403);

  // A body field naming someone else is not identity.
  const impersonated = await call('/api/submissions', {
    method: 'POST',
    token: studentToken,
    body: { assignmentId: 'assignment-api', userId: 'u-admin-1', text: 'not mine' }
  });
  assert.equal(impersonated.status, 403);
});

test('offline signup is student-only, needs a program, and produces a usable credential', async () => {
  const call = loadShim();

  const escalation = await call('/api/signup', {
    method: 'POST',
    body: { name: 'Role Climber', email: 'climber@vfu.local', password: 'password1', role: 'admin', programId: 'prog-ict', studentNumber: 'VFU-ST-2026-777' }
  });
  assert.equal(escalation.status, 201);
  assert.equal(escalation.payload.user.role, 'student');
  assert.equal(escalation.payload.user.programId, 'prog-ict');

  const unassigned = await call('/api/signup', {
    method: 'POST',
    body: { name: 'No Program', email: 'noprogram@vfu.local', password: 'password1', studentNumber: 'VFU-ST-2026-778' }
  });
  assert.equal(unassigned.status, 400);
  assert.match(unassigned.payload.error, /program/i);

  const backIn = await call('/api/login', { method: 'POST', body: { role: 'student', email: 'climber@vfu.local', password: 'password1' } });
  assert.equal(backIn.status, 200);

  const wrongPassword = await call('/api/login', { method: 'POST', body: { role: 'student', email: 'climber@vfu.local', password: 'password2' } });
  assert.equal(wrongPassword.status, 401);
});

test('offline logout revokes the token', async () => {
  const call = loadShim();
  const token = await signIn(call, 'lecturer', 'lecturer@vfu.local', 'lecturer123');

  assert.equal((await call('/api/state', { token })).payload.authenticated, true);
  assert.equal((await call('/api/logout', { method: 'POST', token })).status, 200);
  assert.equal((await call('/api/state', { token })).payload.authenticated, false);
});

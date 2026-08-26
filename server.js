const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
// The dataset ships with the repo, but a host can point the app at a mounted
// persistent disk with DATA_DIR (Render disks, for example) so the data
// survives restarts and redeploys. On first boot against an empty disk the
// bundled file is copied across, so a fresh mount starts seeded rather than
// with the near-empty defaultData.
const SEED_FILE = path.join(ROOT, "data", "vfu-data.json");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "vfu-data.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon"
};

const DB_ENABLED = Boolean(process.env.DB_HOST);
const dbConfig = {
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "vfu_db",
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 3000
};

const SESSION_TTL_MS = Number(process.env.SESSION_TTL_HOURS || 12) * 60 * 60 * 1000;

let dbPool = null;

function hashPassword(value) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(value || ""), salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(value, stored) {
  const [scheme, salt, hashHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !salt || !hashHex) return false;
  const hash = crypto.scryptSync(String(value || ""), salt, 64);
  const storedBuf = Buffer.from(hashHex, "hex");
  return hash.length === storedBuf.length && crypto.timingSafeEqual(hash, storedBuf);
}

function issueSession(data, user) {
  const token = crypto.randomBytes(24).toString("hex");
  const now = Date.now();
  data.sessions = (data.sessions || []).filter((session) => session.expiresAt > now);
  data.sessions.push({
    token,
    userId: user.id,
    role: user.role,
    name: user.name,
    email: user.email,
    createdAt: now,
    expiresAt: now + SESSION_TTL_MS
  });
  writeData(data);
  return token;
}

// Shared by both auth transports: the Authorization header (regular REST calls)
// and a token query-string param (WebSocket handshakes, which can't set headers).
function resolveSessionToken(data, token) {
  if (!token) return null;
  const now = Date.now();
  const session = (data.sessions || []).find((item) => item.token === token && item.expiresAt > now);
  if (!session) return null;
  // Role is re-resolved from the live user record (not the session snapshot) so an
  // admin-driven role change takes effect immediately, not after the token expires.
  const liveUser = data.users.find((item) => item.id === session.userId);
  const role = liveUser ? liveUser.role : session.role;
  const name = liveUser ? liveUser.name : session.name;
  const email = liveUser ? liveUser.email : session.email;
  return { user: { id: session.userId, role, name, email }, session };
}

function authenticate(req, data) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || "").trim());
  if (!match) return null;
  return resolveSessionToken(data, match[1]);
}

const STAFF_ROLES = ["lecturer", "admin"];

function requireSession(req, res, data) {
  const auth = authenticate(req, data);
  if (!auth) {
    sendJson(res, 401, { error: "Sign in required." });
    return null;
  }
  return auth;
}

function requireRole(auth, res, allowedRoles) {
  if (!allowedRoles.includes(auth.user.role)) {
    sendJson(res, 403, { error: "You do not have permission to perform this action." });
    return false;
  }
  return true;
}

const rateLimitBuckets = new Map();

// Peek only — recordAttempt() is what fills the bucket. Login records just its
// failures, so a lab full of students signing in legitimately from one NAT'd IP
// is never locked out, while password guessing still runs out of attempts.
function isRateLimited(key, limit = 10, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
  rateLimitBuckets.set(key, bucket);
  return bucket.length >= limit;
}

function recordAttempt(key, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
  bucket.push(now);
  rateLimitBuckets.set(key, bucket);
}

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'self'; form-action 'self'"
  );
}

function stripPasswordHash(user) {
  const { passwordHash, ...safeUser } = user;
  return safeUser;
}

function mapDbUser(row) {
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    role: row.role,
    program: row.program || "VFU",
    programId: row.program_id || null,
    studentNumber: row.student_number || "",
    staffNumber: row.staff_number || "",
    phone: row.phone || "",
    avatar: row.avatar || "VU",
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : new Date().toISOString()
  };
}

async function ensureUsersTableSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id VARCHAR(64) PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      email VARCHAR(255) NOT NULL UNIQUE,
      role VARCHAR(32) NOT NULL,
      program VARCHAR(255),
      program_id VARCHAR(64),
      student_number VARCHAR(100),
      staff_number VARCHAR(100),
      phone VARCHAR(100),
      avatar VARCHAR(16),
      password_hash VARCHAR(255) NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  const [columns] = await pool.query("SHOW COLUMNS FROM users");
  const columnNames = new Set(columns.map((column) => column.Field));
  const migrations = [
    ["program", "ALTER TABLE users ADD COLUMN program VARCHAR(255)"],
    ["program_id", "ALTER TABLE users ADD COLUMN program_id VARCHAR(64)"],
    ["student_number", "ALTER TABLE users ADD COLUMN student_number VARCHAR(100)"],
    ["staff_number", "ALTER TABLE users ADD COLUMN staff_number VARCHAR(100)"],
    ["phone", "ALTER TABLE users ADD COLUMN phone VARCHAR(100)"],
    ["avatar", "ALTER TABLE users ADD COLUMN avatar VARCHAR(16)"],
    ["password_hash", "ALTER TABLE users ADD COLUMN password_hash VARCHAR(255) NOT NULL DEFAULT ''"],
    ["created_at", "ALTER TABLE users ADD COLUMN created_at DATETIME DEFAULT CURRENT_TIMESTAMP"]
  ];

  for (const [columnName, statement] of migrations) {
    if (!columnNames.has(columnName)) {
      await pool.query(statement);
      columnNames.add(columnName);
    }
  }
}

async function getDbPool() {
  if (!DB_ENABLED) {
    return null;
  }

  if (dbPool) {
    return dbPool;
  }

  try {
    dbPool = mysql.createPool(dbConfig);
    await dbPool.query("SELECT 1");
    await ensureUsersTableSchema(dbPool);

    const demoUsers = [
      {
        id: "u-student-1",
        name: "Alex Likando",
        email: "student@vfu.local",
        role: "student",
        program: "BSc Information and Communication Technology",
        program_id: "prog-ict",
        student_number: "VFU-ST-2026-001",
        staff_number: null,
        phone: "",
        avatar: "AL",
        password_hash: hashPassword("student123")
      },
      {
        id: "u-lecturer-1",
        name: "Dr. Naomi Banda",
        email: "lecturer@vfu.local",
        role: "lecturer",
        program: "School of ICT",
        program_id: "prog-ict",
        student_number: null,
        staff_number: "VFU-LEC-2026-001",
        phone: "",
        avatar: "NB",
        password_hash: hashPassword("lecturer123")
      },
      {
        id: "u-admin-1",
        name: "System Administrator",
        email: "admin@vfu.local",
        role: "admin",
        program: "Academic Registry",
        program_id: null,
        student_number: null,
        staff_number: "VFU-ADM-2026-001",
        phone: "",
        avatar: "SA",
        password_hash: hashPassword("admin123")
      }
    ];

    for (const user of demoUsers) {
      await dbPool.query(
        `INSERT INTO users (id, name, email, role, program, program_id, student_number, staff_number, phone, avatar, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           role = VALUES(role),
           program = VALUES(program),
           program_id = VALUES(program_id),
           student_number = VALUES(student_number),
           staff_number = VALUES(staff_number),
           phone = VALUES(phone),
           avatar = VALUES(avatar),
           password_hash = VALUES(password_hash)`,
        [user.id, user.name, user.email, user.role, user.program, user.program_id, user.student_number, user.staff_number, user.phone, user.avatar, user.password_hash]
      );
    }

    return dbPool;
  } catch (error) {
    console.warn("MySQL unavailable; falling back to JSON auth:", error.message);
    return null;
  }
}

const defaultData = {
  institution: {
    name: "VFU E-Learning Classroom",
    tagline: "Interactive learning, attendance, collaboration, and academic monitoring.",
    term: "June 2026 Semester"
  },
  programs: [
    { id: "prog-ict", name: "Information and Communication Technology", code: "ICT" },
    { id: "prog-biz", name: "Business and Financial Management", code: "BIZ" }
  ],
  users: [
    {
      id: "u-student-1",
      name: "Alex Likando",
      email: "student@vfu.local",
      role: "student",
      program: "BSc Information and Communication Technology",
      avatar: "AL",
      createdAt: "2026-01-12T08:00:00.000Z",
      pendingBalance: 2500,
      passwordHash: hashPassword("student123")
    },
    {
      id: "u-lecturer-1",
      name: "Dr. Naomi Banda",
      email: "lecturer@vfu.local",
      role: "lecturer",
      program: "School of ICT",
      avatar: "NB",
      passwordHash: hashPassword("lecturer123")
    },
    {
      id: "u-admin-1",
      name: "System Administrator",
      email: "admin@vfu.local",
      role: "admin",
      program: "Academic Registry",
      avatar: "SA",
      passwordHash: hashPassword("admin123")
    }
  ],
  courses: [],
  classSessions: [],
  attendance: [],
  assignments: [],
  submissions: [],
  discussions: [],
  studyRooms: [],
  notifications: [],
  announcements: [],
  tutorials: [],
  materials: [],
  presentations: [],
  messages: [],
  analytics: {
    activeStudents: 0,
    attendanceRate: 0,
    submissionRate: 0,
    averageGrade: 0,
    weeklyEngagement: [],
    courseCompletion: []
  }
};

// One-time-per-read migration helper: maps the legacy free-text program/department
// string to a broad academic field, used only to backfill programId on old records.
function legacyFieldForProgram(value) {
  const text = String(value || "").toLowerCase();
  if (/(ict|information|computer|software|network|technolog)/.test(text)) return "ICT";
  if (/(business|financial|account|management|marketing)/.test(text)) return "Business";
  return null;
}

function backfillPrograms(shaped) {
  const byCode = new Map(shaped.programs.map((program) => [program.code, program]));
  const legacyToProgramId = { ICT: byCode.get("ICT")?.id || null, Business: byCode.get("BIZ")?.id || null };

  for (const user of shaped.users) {
    if (!user.programId) {
      const field = legacyFieldForProgram(user.program);
      user.programId = field ? legacyToProgramId[field] : null;
    }
  }

  for (const course of shaped.courses) {
    if (course.parentCourseId === undefined) course.parentCourseId = null;
    if (!course.programId) {
      const field = legacyFieldForProgram(course.department);
      course.programId = field ? legacyToProgramId[field] : null;
    }
  }

  return shaped;
}

function ensureDataShape(data) {
  const normalized = data && typeof data === "object" ? data : {};
  const shaped = {
    institution: normalized.institution || defaultData.institution,
    programs: Array.isArray(normalized.programs) && normalized.programs.length ? normalized.programs : defaultData.programs,
    users: Array.isArray(normalized.users) ? normalized.users : [],
    courses: Array.isArray(normalized.courses) ? normalized.courses : [],
    classSessions: Array.isArray(normalized.classSessions) ? normalized.classSessions : [],
    attendance: Array.isArray(normalized.attendance) ? normalized.attendance : [],
    assignments: Array.isArray(normalized.assignments) ? normalized.assignments : [],
    submissions: Array.isArray(normalized.submissions) ? normalized.submissions : [],
    discussions: Array.isArray(normalized.discussions) ? normalized.discussions : [],
    studyRooms: Array.isArray(normalized.studyRooms) ? normalized.studyRooms : [],
    notifications: Array.isArray(normalized.notifications) ? normalized.notifications : [],
    announcements: Array.isArray(normalized.announcements) ? normalized.announcements : [],
    tutorials: Array.isArray(normalized.tutorials) ? normalized.tutorials : [],
    materials: Array.isArray(normalized.materials) ? normalized.materials : [],
    presentations: Array.isArray(normalized.presentations) ? normalized.presentations : [],
    messages: Array.isArray(normalized.messages) ? normalized.messages : [],
    sessions: Array.isArray(normalized.sessions) ? normalized.sessions : [],
    analytics: normalized.analytics && typeof normalized.analytics === "object" ? normalized.analytics : defaultData.analytics
  };
  return backfillPrograms(shaped);
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
    // A freshly mounted disk is empty: seed it from the copy that ships with
    // the build rather than starting the institution with no courses at all.
    if (DATA_FILE !== SEED_FILE && fs.existsSync(SEED_FILE)) {
      try {
        const seeded = ensureDataShape(JSON.parse(fs.readFileSync(SEED_FILE, "utf8")));
        seeded.sessions = [];
        writeData(seeded);
        return seeded;
      } catch (error) {
        console.warn("Could not seed the data disk from the bundled dataset:", error.message);
      }
    }
    writeData(defaultData);
    return ensureDataShape(defaultData);
  }

  try {
    return ensureDataShape(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
  } catch (error) {
    const backupFile = `${DATA_FILE}.bak`;
    if (fs.existsSync(backupFile)) {
      const backup = fs.readFileSync(backupFile, "utf8");
      return ensureDataShape(JSON.parse(backup));
    }

    writeData(defaultData);
    return ensureDataShape(defaultData);
  }
}

function writeData(data) {
  const normalized = ensureDataShape(data);
  // A mounted disk can be empty on first boot, so make sure the directory is
  // there before the atomic write/rename below.
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tempFile = `${DATA_FILE}.tmp`;
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;
  fs.writeFileSync(tempFile, payload, "utf8");
  fs.renameSync(tempFile, DATA_FILE);
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

function sendText(res, status, text) {
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error("Request body is too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!body) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function sanitizeText(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || ""));
}

function validatePassword(password) {
  const pwd = String(password || "");
  if (pwd.length < 6) return "Password must be at least 6 characters.";
  return null;
}

function normalizeRole(value) {
  const role = String(value || "student").toLowerCase();
  return role === "lecturer" || role === "admin" ? role : "student";
}

// Strict program access: a student can only see/join a course when both records
// carry the same programId. Missing programId on either side denies access
// (never falls back to "allow everything", unlike the old free-text heuristic).
function canAccessCourse(user, course) {
  if (!user || user.role !== "student") return true;
  if (!course) return false;
  return Boolean(user.programId) && Boolean(course.programId) && user.programId === course.programId;
}

function publicFilePath(urlPath) {
  const requested = urlPath === "/" ? "/index.html" : urlPath;
  let decoded;
  try {
    decoded = decodeURIComponent(requested);
  } catch (error) {
    // Malformed percent-encoding (e.g. "/%E0%A4%A") — reject instead of crashing the process.
    return null;
  }
  const normalized = path.normalize(decoded).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(PUBLIC_DIR, normalized);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    return null;
  }

  return filePath;
}

// Returns true when the caller was signed in, false for every rejected attempt
// (the caller uses that to decide whether to charge the rate-limit bucket).
async function handleLogin(res, data, body) {
  const role = normalizeRole(body.role);
  const email = sanitizeText(body.email).toLowerCase();
  const password = String(body.password || "");

  if (!isValidEmail(email)) {
    sendJson(res, 400, { error: "Please provide a valid email address." });
    return false;
  }

  const pool = await getDbPool();
  if (pool) {
    try {
      const [rows] = await pool.query("SELECT * FROM users WHERE email = ? AND role = ? LIMIT 1", [email, role]);
      const row = rows[0];
      if (row && verifyPassword(password, row.password_hash)) {
        const user = mapDbUser(row);
        sendJson(res, 200, { user, token: issueSession(data, user) });
        return true;
      }
      sendJson(res, 401, { error: "Incorrect email, role, or password." });
      return false;
    } catch (error) {
      console.warn("MySQL login lookup failed:", error.message);
    }
  }

  const fallbackUser = data.users.find(
    (candidate) => candidate.role === role && candidate.email.toLowerCase() === email
  );

  if (!fallbackUser || !verifyPassword(password, fallbackUser.passwordHash)) {
    sendJson(res, 401, { error: "Incorrect email, role, or password." });
    return false;
  }

  sendJson(res, 200, { user: stripPasswordHash(fallbackUser), token: issueSession(data, fallbackUser) });
  return true;
}

// Shared account-creation logic used by both public signup (role forced to
// "student") and the admin-only provisioning endpoint (role from the caller).
// Handles the MySQL path when enabled, falling back to the JSON users array.
async function createUserRecord(data, input) {
  const name = sanitizeText(input.name);
  const email = sanitizeText(input.email).toLowerCase();
  const role = normalizeRole(input.role);
  const password = String(input.password || "");

  if (!name || !email) return { status: 400, error: "Name and email are required." };
  if (!isValidEmail(email)) return { status: 400, error: "Please provide a valid email address." };
  const pwdError = validatePassword(password);
  if (pwdError) return { status: 400, error: pwdError };

  const programId = sanitizeText(input.programId) || null;
  const programRecord = programId ? (data.programs || []).find((item) => item.id === programId) : null;
  const program = sanitizeText(input.program || input.department || (programRecord ? programRecord.name : "") || "VFU");
  const studentNumber = sanitizeText(input.studentNumber);
  const staffNumber = sanitizeText(input.staffNumber);
  const phone = sanitizeText(input.phone);
  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "VU";

  const pool = await getDbPool();
  if (pool) {
    try {
      const [existingRows] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (existingRows[0]) return { status: 409, error: "An account with that email already exists." };

      const userId = `u-${role}-${Date.now()}`;
      await pool.query(
        `INSERT INTO users (id, name, email, role, program, program_id, student_number, staff_number, phone, avatar, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, name, email, role, program, programId, studentNumber, staffNumber, phone, initials, hashPassword(password)]
      );

      return {
        status: 201,
        user: { id: userId, name, email, role, program, programId, studentNumber, staffNumber, phone, avatar: initials, createdAt: new Date().toISOString() }
      };
    } catch (error) {
      console.warn("MySQL user insert failed:", error.message);
    }
  }

  if (data.users.some((candidate) => candidate.email.toLowerCase() === email)) {
    return { status: 409, error: "An account with that email already exists." };
  }

  const user = {
    id: `u-${role}-${Date.now()}`,
    name,
    email,
    role,
    program,
    programId,
    studentNumber,
    staffNumber,
    phone,
    avatar: initials,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  data.users.push(user);
  writeData(data);
  return { status: 201, user };
}

async function handleSignup(res, data, body) {
  // Public self-registration is student-only. Elevated roles (lecturer/admin)
  // must be provisioned by an existing admin via POST /api/admin/users, not
  // chosen by the signup caller — otherwise anyone can register as an admin.
  const programId = sanitizeText(body.programId);
  if (!programId || !(data.programs || []).some((program) => program.id === programId)) {
    // No unassigned self-registrations: a student account is only meaningful
    // against a real program, and course access is granted off that field.
    sendJson(res, 400, { error: "Choose the program you are registered for." });
    return;
  }

  const studentNumber = sanitizeText(body.studentNumber);
  if (!studentNumber) {
    sendJson(res, 400, { error: "Your student number is required to register." });
    return;
  }

  const result = await createUserRecord(data, { ...body, programId, studentNumber, role: "student" });
  if (result.error) {
    sendJson(res, result.status, { error: result.error });
    return;
  }
  sendJson(res, 201, { user: stripPasswordHash(result.user), token: issueSession(data, result.user) });
}

// Admin-only: the sole path in the app that can create a lecturer or admin account.
async function createStaffUser(res, data, body) {
  const result = await createUserRecord(data, body);
  if (result.error) {
    sendJson(res, result.status, { error: result.error });
    return;
  }
  sendJson(res, 201, { user: stripPasswordHash(result.user) });
}

function isValidAvatar(value) {
  if (typeof value !== "string") return false;
  if (/^[A-Za-z]{1,3}$/.test(value)) return true;
  return value.startsWith("data:image/") && value.length <= 300_000;
}

// Self-service profile edit: every field except avatar is ignored, even if present
// in the body. Everything else requires an admin via updateUserRecord below.
async function updateOwnProfile(res, data, authUser, body) {
  if (body.avatar === undefined || !isValidAvatar(body.avatar)) {
    sendJson(res, 400, { error: "Provide an avatar as initials or a small image (max 300KB)." });
    return;
  }

  const pool = await getDbPool();
  if (pool) {
    try {
      const [rows] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [authUser.id]);
      if (rows[0]) {
        await pool.query("UPDATE users SET avatar = ? WHERE id = ?", [body.avatar, authUser.id]);
        const [updatedRows] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [authUser.id]);
        sendJson(res, 200, { user: mapDbUser(updatedRows[0]) });
        return;
      }
    } catch (error) {
      console.warn("MySQL profile update failed:", error.message);
    }
  }

  const user = data.users.find((item) => item.id === authUser.id);
  if (!user) {
    sendJson(res, 404, { error: "User was not found." });
    return;
  }
  user.avatar = body.avatar;
  writeData(data);
  sendJson(res, 200, { user: stripPasswordHash(user) });
}

// Admin-only full edit. This is the sole place a user's role can change after
// account creation, so every caller of this function must already be admin-gated.
async function updateUserRecord(res, data, userId, body) {
  if (body.programId !== undefined && body.programId && !data.programs.some((program) => program.id === body.programId)) {
    sendJson(res, 400, { error: "Program was not found." });
    return;
  }
  if (body.password !== undefined) {
    const pwdError = validatePassword(body.password);
    if (pwdError) {
      sendJson(res, 400, { error: pwdError });
      return;
    }
  }
  let email = null;
  if (body.email !== undefined) {
    email = sanitizeText(body.email).toLowerCase();
    if (!isValidEmail(email)) {
      sendJson(res, 400, { error: "Please provide a valid email address." });
      return;
    }
  }

  const pool = await getDbPool();
  if (pool) {
    try {
      const [rows] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [userId]);
      if (rows[0]) {
        if (email) {
          const [existing] = await pool.query("SELECT id FROM users WHERE email = ? AND id <> ? LIMIT 1", [email, userId]);
          if (existing[0]) {
            sendJson(res, 409, { error: "Another account already uses that email." });
            return;
          }
        }
        const fieldToColumn = { name: "name", program: "program", programId: "program_id", studentNumber: "student_number", staffNumber: "staff_number", phone: "phone", avatar: "avatar" };
        const sets = [];
        const values = [];
        for (const [field, column] of Object.entries(fieldToColumn)) {
          if (body[field] !== undefined) {
            sets.push(`${column} = ?`);
            values.push(sanitizeText(body[field]) || null);
          }
        }
        if (email) { sets.push("email = ?"); values.push(email); }
        if (body.role !== undefined) { sets.push("role = ?"); values.push(normalizeRole(body.role)); }
        if (body.password) { sets.push("password_hash = ?"); values.push(hashPassword(body.password)); }
        if (sets.length) {
          values.push(userId);
          await pool.query(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, values);
        }
        const [updatedRows] = await pool.query("SELECT * FROM users WHERE id = ? LIMIT 1", [userId]);
        sendJson(res, 200, { user: mapDbUser(updatedRows[0]) });
        return;
      }
    } catch (error) {
      console.warn("MySQL user update failed:", error.message);
    }
  }

  const user = data.users.find((item) => item.id === userId);
  if (!user) {
    sendJson(res, 404, { error: "User was not found." });
    return;
  }

  if (email) {
    if (data.users.some((candidate) => candidate.id !== userId && candidate.email.toLowerCase() === email)) {
      sendJson(res, 409, { error: "Another account already uses that email." });
      return;
    }
    user.email = email;
  }
  if (body.programId !== undefined) user.programId = sanitizeText(body.programId) || null;
  if (body.role !== undefined) user.role = normalizeRole(body.role);
  if (body.password) user.passwordHash = hashPassword(body.password);
  for (const field of ["name", "program", "studentNumber", "staffNumber", "phone", "avatar"]) {
    if (body[field] !== undefined) user[field] = sanitizeText(body[field]);
  }

  writeData(data);
  sendJson(res, 200, { user: stripPasswordHash(user) });
}

function addAttendance(res, data, body) {
  const session = data.classSessions.find((item) => item.id === body.sessionId);
  const user = data.users.find((item) => item.id === body.userId);

  if (!session || !user) {
    sendJson(res, 404, { error: "Session or user was not found." });
    return;
  }

  const alreadyPresent = data.attendance.some(
    (item) => item.sessionId === session.id && item.userId === user.id
  );

  if (!alreadyPresent) {
    data.attendance.push({
      id: `att-${Date.now()}`,
      sessionId: session.id,
      courseId: session.courseId,
      userId: user.id,
      status: "Present",
      joinedAt: new Date().toISOString()
    });
    writeData(data);
  }

  sendJson(res, 200, { attendance: data.attendance, message: "Attendance recorded." });
}

function submitAssignment(res, data, body) {
  const assignment = data.assignments.find((item) => item.id === body.assignmentId);
  const user = data.users.find((item) => item.id === body.userId);
  const text = sanitizeText(body.text);
  const fileName = sanitizeText(body.fileName);
  const fileType = sanitizeText(body.fileType);
  const fileSize = Number(body.fileSize) > 0 ? Number(body.fileSize) : 0;
  const fileData = typeof body.fileData === "string" && body.fileData.startsWith("data:") && body.fileData.length <= 800_000
    ? body.fileData
    : "";

  if (!assignment || !user) {
    sendJson(res, 404, { error: "Assignment or user was not found." });
    return;
  }

  if (!text && !fileName) {
    sendJson(res, 400, { error: "Submission text or an attached file is required." });
    return;
  }

  const existing = data.submissions.find(
    (item) => item.assignmentId === assignment.id && item.userId === user.id
  );

  if (existing) {
    existing.text = text;
    existing.fileName = fileName || existing.fileName || "";
    existing.fileType = fileType || existing.fileType || "";
    existing.fileSize = fileSize || existing.fileSize || 0;
    if (fileData) existing.fileData = fileData;
    existing.submittedAt = new Date().toISOString();
    existing.status = "Submitted";
  } else {
    data.submissions.push({
      id: `sub-${Date.now()}`,
      assignmentId: assignment.id,
      courseId: assignment.courseId,
      userId: user.id,
      text,
      fileName,
      fileType,
      fileSize,
      fileData,
      status: "Submitted",
      grade: null,
      submittedAt: new Date().toISOString()
    });
  }

  writeData(data);
  sendJson(res, 200, { submissions: data.submissions, message: "Assignment submitted." });
}

function createAssignment(res, data, body) {
  const course = data.courses.find((item) => item.id === body.courseId);
  const title = sanitizeText(body.title);

  if (!course || !title) {
    sendJson(res, 400, { error: "A valid course and assignment title are required." });
    return;
  }

  const due = new Date(body.dueAt || "");
  const assignment = {
    id: `assignment-${Date.now()}`,
    courseId: course.id,
    title,
    description: sanitizeText(body.description),
    dueAt: Number.isNaN(due.getTime()) ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() : due.toISOString(),
    points: Number(body.points) > 0 ? Number(body.points) : 10,
    status: "Open"
  };

  data.assignments.push(assignment);
  writeData(data);
  sendJson(res, 201, { assignment, assignments: data.assignments });
}

function startClassSession(res, data, body, authUser) {
  const course = data.courses.find((item) => item.id === body.courseId);
  if (!course) {
    sendJson(res, 404, { error: "Course was not found." });
    return;
  }

  if (data.classSessions.some((item) => item.courseId === course.id && item.status === "Live")) {
    sendJson(res, 409, { error: "A live class is already running for this course." });
    return;
  }

  const duration = Number(body.duration);
  const session = {
    id: `session-${Date.now()}`,
    courseId: course.id,
    title: sanitizeText(body.title) || `${course.title} live class`,
    startsAt: new Date().toISOString(),
    duration: duration > 0 ? Math.min(duration, 480) : 60,
    status: "Live",
    participants: 0,
    hostId: authUser.id
  };

  data.classSessions.push(session);
  writeData(data);
  sendJson(res, 201, { session, classSessions: data.classSessions });
}

function scheduleClassSession(res, data, body, authUser) {
  const course = data.courses.find((item) => item.id === body.courseId);
  if (!course) {
    sendJson(res, 404, { error: "Course was not found." });
    return;
  }

  const startsAt = new Date(body.startsAt || "");
  if (Number.isNaN(startsAt.getTime()) || startsAt.getTime() <= Date.now()) {
    sendJson(res, 400, { error: "Scheduled time must be a valid date in the future." });
    return;
  }

  const duration = Number(body.duration);
  const session = {
    id: `session-${Date.now()}`,
    courseId: course.id,
    title: sanitizeText(body.title) || `${course.title} live class`,
    startsAt: startsAt.toISOString(),
    duration: duration > 0 ? Math.min(duration, 480) : 60,
    status: "Scheduled",
    participants: 0,
    hostId: authUser.id
  };

  data.classSessions.push(session);
  writeData(data);
  sendJson(res, 201, { session, classSessions: data.classSessions });
}

function beginScheduledSession(res, data, body, authUser) {
  const session = data.classSessions.find((item) => item.id === body.sessionId);
  if (!session) {
    sendJson(res, 404, { error: "Class session was not found." });
    return;
  }

  if (session.status !== "Scheduled") {
    sendJson(res, 409, { error: "This session is not in a scheduled state." });
    return;
  }

  if (data.classSessions.some((item) => item.courseId === session.courseId && item.status === "Live")) {
    sendJson(res, 409, { error: "A live class is already running for this course." });
    return;
  }

  session.status = "Live";
  session.startsAt = new Date().toISOString();
  session.hostId = authUser.id;

  writeData(data);
  sendJson(res, 200, { session, classSessions: data.classSessions });
}

function joinClassSession(res, data, body, authUser) {
  const session = data.classSessions.find((item) => item.id === body.sessionId);
  if (!session) {
    sendJson(res, 404, { error: "Class session was not found." });
    return;
  }

  if (session.status !== "Live") {
    sendJson(res, 409, { error: "This class is not live right now." });
    return;
  }

  const course = data.courses.find((item) => item.id === session.courseId);
  const user = data.users.find((item) => item.id === authUser.id) || authUser;
  if (!canAccessCourse(user, course)) {
    sendJson(res, 403, { error: "This class is only open to students enrolled in its field." });
    return;
  }

  if (user.role === "student" && user.studentNumber && sanitizeText(body.studentNumber) !== user.studentNumber) {
    sendJson(res, 403, { error: "The student number you entered does not match our records." });
    return;
  }

  // Joining a live class is what marks a student present (auto-attendance).
  if (user.role === "student") {
    const already = data.attendance.some((item) => item.sessionId === session.id && item.userId === user.id);
    if (!already) {
      data.attendance.push({
        id: `att-${Date.now()}`,
        sessionId: session.id,
        courseId: session.courseId,
        userId: user.id,
        status: "Present",
        joinedAt: new Date().toISOString()
      });
      session.participants = Number(session.participants || 0) + 1;
      writeData(data);
    }
  }

  sendJson(res, 200, { session, attendance: data.attendance, message: "Joined the live class." });
}

function endClassSession(res, data, body) {
  const session = data.classSessions.find((item) => item.id === body.sessionId);
  if (!session) {
    sendJson(res, 404, { error: "Class session was not found." });
    return;
  }

  if (session.status !== "Live") {
    sendJson(res, 409, { error: "This class is not live." });
    return;
  }

  session.status = "Ended";
  session.endedAt = new Date().toISOString();

  // Students in the course's field who never joined are marked absent automatically.
  const course = data.courses.find((item) => item.id === session.courseId);
  for (const user of data.users) {
    if (user.role !== "student" || !canAccessCourse(user, course)) continue;
    const marked = data.attendance.some((item) => item.sessionId === session.id && item.userId === user.id);
    if (!marked) {
      data.attendance.push({
        id: `att-${Date.now()}-${user.id}`,
        sessionId: session.id,
        courseId: session.courseId,
        userId: user.id,
        status: "Absent",
        joinedAt: null
      });
    }
  }

  writeData(data);
  wsClearChannelBoard(session.id);
  sendJson(res, 200, { session, attendance: data.attendance, message: "Class ended. Missing students were marked absent." });
}

function createStudyRoom(res, data, body, authUser) {
  const course = data.courses.find((item) => item.id === body.courseId);
  const topic = sanitizeText(body.topic);

  if (!course || !topic) {
    sendJson(res, 400, { error: "A valid course and study topic are required." });
    return;
  }

  const user = data.users.find((item) => item.id === authUser.id) || authUser;
  if (!canAccessCourse(user, course)) {
    sendJson(res, 403, { error: "You can only open study rooms for courses in your field." });
    return;
  }

  const room = {
    id: `room-${Date.now()}`,
    courseId: course.id,
    topic,
    hostId: user.id,
    hostName: user.name,
    status: "Open",
    createdAt: new Date().toISOString(),
    members: [user.id]
  };

  data.studyRooms.push(room);
  writeData(data);
  sendJson(res, 201, { room, studyRooms: data.studyRooms });
}

function joinStudyRoom(res, data, body, authUser) {
  const room = data.studyRooms.find((item) => item.id === body.roomId);
  if (!room || room.status !== "Open") {
    sendJson(res, 404, { error: "Study room is not open." });
    return;
  }

  const course = data.courses.find((item) => item.id === room.courseId);
  const user = data.users.find((item) => item.id === authUser.id) || authUser;
  if (!canAccessCourse(user, course)) {
    sendJson(res, 403, { error: "This room is private to students of its course field." });
    return;
  }

  if (user.role === "student" && user.studentNumber && sanitizeText(body.studentNumber) !== user.studentNumber) {
    sendJson(res, 403, { error: "The student number you entered does not match our records." });
    return;
  }

  if (!room.members.includes(user.id)) {
    room.members.push(user.id);
    writeData(data);
  }

  sendJson(res, 200, { room, studyRooms: data.studyRooms });
}

function closeStudyRoom(res, data, body, authUser) {
  const room = data.studyRooms.find((item) => item.id === body.roomId);
  if (!room) {
    sendJson(res, 404, { error: "Study room was not found." });
    return;
  }

  if (room.hostId !== authUser.id && authUser.role === "student") {
    sendJson(res, 403, { error: "Only the host can close this room." });
    return;
  }

  room.status = "Closed";
  writeData(data);
  wsClearChannelBoard(room.id);
  sendJson(res, 200, { room, studyRooms: data.studyRooms });
}

function addForumMessage(res, data, body) {
  const discussion = data.discussions.find((item) => item.id === body.discussionId);
  const user = data.users.find((item) => item.id === body.userId);
  const text = sanitizeText(body.text);

  if (!discussion || !user) {
    sendJson(res, 404, { error: "Discussion or user was not found." });
    return;
  }

  if (!text) {
    sendJson(res, 400, { error: "Reply text is required." });
    return;
  }

  discussion.replies.push({
    id: `reply-${Date.now()}`,
    userId: user.id,
    author: user.name,
    text,
    createdAt: new Date().toISOString()
  });

  writeData(data);
  sendJson(res, 200, { discussions: data.discussions, message: "Reply posted." });
}

// Simple 1:1 direct messaging, no group threads. Persisted (unlike live-room chat/board,
// which are WS-only): REST is authoritative, the WS push in handleApi's /api/messages
// route is purely a live-delivery optimization for a recipient with an open connection.
function sendMessage(res, data, body, authUser) {
  const recipientId = sanitizeText(body.recipientId);
  const text = sanitizeText(body.text);

  if (!recipientId || !data.users.some((user) => user.id === recipientId)) {
    sendJson(res, 400, { error: "Recipient was not found." });
    return;
  }
  if (recipientId === authUser.id) {
    sendJson(res, 400, { error: "You cannot message yourself." });
    return;
  }
  if (!text) {
    sendJson(res, 400, { error: "Message text is required." });
    return;
  }

  const message = {
    id: `msg-${Date.now()}`,
    senderId: authUser.id,
    recipientId,
    text,
    createdAt: new Date().toISOString(),
    read: false
  };

  data.messages.push(message);
  writeData(data);
  wsSendToUser(recipientId, { type: "message", payload: { message }, from: { id: authUser.id, name: authUser.name, role: authUser.role }, ts: Date.now() });
  sendJson(res, 201, { message });
}

function listMyMessages(res, data, authUser) {
  const mine = data.messages.filter((item) => item.senderId === authUser.id || item.recipientId === authUser.id);
  sendJson(res, 200, { messages: mine });
}

function updateMessageReadState(res, data, messageId, body, authUser) {
  const message = data.messages.find((item) => item.id === messageId);
  if (!message) {
    sendJson(res, 404, { error: "Message was not found." });
    return;
  }
  if (message.recipientId !== authUser.id) {
    sendJson(res, 403, { error: "Only the recipient can update this message." });
    return;
  }
  if (body.read !== undefined) message.read = Boolean(body.read);
  writeData(data);
  sendJson(res, 200, { message });
}

const ANNOUNCEMENT_TYPES = ["period", "exam", "meeting", "campaign", "news", "announcement"];

function createAnnouncement(res, data, body, authUser) {
  const title = sanitizeText(body.title);
  const type = ANNOUNCEMENT_TYPES.includes(String(body.type)) ? body.type : "announcement";
  const audienceType = ["all", "program", "course"].includes(String(body.audienceType)) ? body.audienceType : "all";
  const eventAt = new Date(body.eventAt || "");

  if (!title) {
    sendJson(res, 400, { error: "Title is required." });
    return;
  }
  if (Number.isNaN(eventAt.getTime())) {
    sendJson(res, 400, { error: "A valid event date/time is required." });
    return;
  }

  let programId = null;
  let courseId = null;
  if (audienceType === "program") {
    programId = sanitizeText(body.programId);
    if (!programId || !data.programs.some((program) => program.id === programId)) {
      sendJson(res, 400, { error: "Program was not found." });
      return;
    }
  } else if (audienceType === "course") {
    courseId = sanitizeText(body.courseId);
    if (!courseId || !data.courses.some((course) => course.id === courseId)) {
      sendJson(res, 400, { error: "Course was not found." });
      return;
    }
  }

  const announcement = {
    id: `announce-${Date.now()}`,
    type,
    title,
    body: sanitizeText(body.body),
    eventAt: eventAt.toISOString(),
    audienceType,
    programId,
    courseId,
    authorId: authUser.id,
    createdAt: new Date().toISOString()
  };

  data.announcements.push(announcement);
  writeData(data);
  sendJson(res, 201, { announcement, announcements: data.announcements });
}

function createTutorial(res, data, body, authUser) {
  const title = sanitizeText(body.title);
  const videoUrl = sanitizeText(body.videoUrl);
  const programId = sanitizeText(body.programId);

  if (!title || !videoUrl) {
    sendJson(res, 400, { error: "Title and a video URL are required." });
    return;
  }
  if (!/^https?:\/\//i.test(videoUrl)) {
    sendJson(res, 400, { error: "Video URL must start with http:// or https://." });
    return;
  }
  if (!programId || !data.programs.some((program) => program.id === programId)) {
    sendJson(res, 400, { error: "A valid program is required." });
    return;
  }

  const tutorial = {
    id: `tutorial-${Date.now()}`,
    title,
    description: sanitizeText(body.description),
    videoUrl,
    programId,
    authorId: authUser.id,
    createdAt: new Date().toISOString()
  };

  data.tutorials.push(tutorial);
  writeData(data);
  sendJson(res, 201, { tutorial, tutorials: data.tutorials });
}

function uploadMaterial(res, data, body, authUser) {
  const title = sanitizeText(body.title);
  const courseId = sanitizeText(body.courseId) || null;
  const programId = sanitizeText(body.programId) || null;
  const fileName = sanitizeText(body.fileName);
  const fileData = typeof body.fileData === "string" && body.fileData.startsWith("data:") && body.fileData.length <= 800_000
    ? body.fileData
    : "";

  if (!title) {
    sendJson(res, 400, { error: "Title is required." });
    return;
  }
  if (!fileName || !fileData) {
    sendJson(res, 400, { error: "A file (under ~600KB) is required." });
    return;
  }
  if (Boolean(courseId) === Boolean(programId)) {
    sendJson(res, 400, { error: "Choose exactly one of course or program for this material." });
    return;
  }

  let course = null;
  if (courseId) {
    course = data.courses.find((item) => item.id === courseId);
    if (!course) {
      sendJson(res, 400, { error: "Course was not found." });
      return;
    }
    if (authUser.role === "lecturer" && course.lecturerId !== authUser.id) {
      sendJson(res, 403, { error: "You can only upload materials for courses assigned to you." });
      return;
    }
  }
  if (programId && !data.programs.some((program) => program.id === programId)) {
    sendJson(res, 400, { error: "Program was not found." });
    return;
  }

  const material = {
    id: `material-${Date.now()}`,
    title,
    description: sanitizeText(body.description),
    courseId,
    programId,
    fileName,
    fileType: sanitizeText(body.fileType),
    fileSize: Number(body.fileSize) > 0 ? Number(body.fileSize) : 0,
    fileData,
    authorId: authUser.id,
    createdAt: new Date().toISOString()
  };

  data.materials.push(material);
  writeData(data);
  sendJson(res, 201, { material, materials: data.materials });
}

const MAX_PRESENTATION_SLIDES = 40;

function createPresentation(res, data, body, authUser) {
  const title = sanitizeText(body.title);
  const slidesInput = Array.isArray(body.slides) ? body.slides : [];

  if (!title) {
    sendJson(res, 400, { error: "Title is required." });
    return;
  }
  if (!slidesInput.length) {
    sendJson(res, 400, { error: "At least one slide is required." });
    return;
  }
  if (slidesInput.length > MAX_PRESENTATION_SLIDES) {
    sendJson(res, 400, { error: `A presentation can have at most ${MAX_PRESENTATION_SLIDES} slides.` });
    return;
  }

  const slides = [];
  for (const [index, slide] of slidesInput.entries()) {
    const dataUrl = slide && typeof slide.dataUrl === "string" && slide.dataUrl.startsWith("data:") && slide.dataUrl.length <= 800_000
      ? slide.dataUrl
      : null;
    if (!dataUrl) {
      sendJson(res, 400, { error: `Slide ${index + 1} is missing a valid image (under ~600KB each).` });
      return;
    }
    slides.push({ id: `slide-${Date.now()}-${index}`, dataUrl, order: index });
  }

  const sessionId = sanitizeText(body.sessionId) || null;
  if (sessionId && !data.classSessions.some((item) => item.id === sessionId)) {
    sendJson(res, 400, { error: "Class session was not found." });
    return;
  }
  const courseId = sanitizeText(body.courseId) || null;
  if (courseId && !data.courses.some((item) => item.id === courseId)) {
    sendJson(res, 400, { error: "Course was not found." });
    return;
  }

  const presentation = {
    id: `presentation-${Date.now()}`,
    sessionId,
    courseId,
    title,
    slides,
    currentIndex: 0,
    hostId: authUser.id,
    createdAt: new Date().toISOString()
  };

  data.presentations.push(presentation);
  writeData(data);
  sendJson(res, 201, { presentation, presentations: data.presentations });
}

function updatePresentation(res, data, presentationId, body, authUser) {
  const presentation = data.presentations.find((item) => item.id === presentationId);
  if (!presentation) {
    sendJson(res, 404, { error: "Presentation was not found." });
    return;
  }
  if (presentation.hostId !== authUser.id && authUser.role !== "admin") {
    sendJson(res, 403, { error: "Only the presentation's host can update it." });
    return;
  }

  if (body.currentIndex !== undefined) {
    const index = Number(body.currentIndex);
    if (!Number.isInteger(index) || index < 0 || index >= presentation.slides.length) {
      sendJson(res, 400, { error: "Slide index is out of range." });
      return;
    }
    presentation.currentIndex = index;
  }
  if (body.title !== undefined) presentation.title = sanitizeText(body.title);

  writeData(data);
  sendJson(res, 200, { presentation, presentations: data.presentations });
}

function createProgram(res, data, body) {
  const name = sanitizeText(body.name);
  const code = sanitizeText(body.code).toUpperCase();

  if (!name || !code) {
    sendJson(res, 400, { error: "Program name and code are required." });
    return;
  }

  if (data.programs.some((program) => program.code.toUpperCase() === code)) {
    sendJson(res, 409, { error: "A program with that code already exists." });
    return;
  }

  const program = { id: `prog-${Date.now()}`, name, code };
  data.programs.push(program);
  writeData(data);
  sendJson(res, 201, { program, programs: data.programs });
}

function createCourse(res, data, body) {
  const title = sanitizeText(body.title);
  const code = sanitizeText(body.code).toUpperCase();

  if (!title || !code) {
    sendJson(res, 400, { error: "Course title and code are required." });
    return;
  }

  const parentCourse = body.parentCourseId ? data.courses.find((item) => item.id === body.parentCourseId) : null;
  if (body.parentCourseId && !parentCourse) {
    sendJson(res, 400, { error: "Parent course was not found." });
    return;
  }

  let programId = sanitizeText(body.programId) || null;
  if (programId && !data.programs.some((program) => program.id === programId)) {
    sendJson(res, 400, { error: "Program was not found." });
    return;
  }
  if (!programId && parentCourse) programId = parentCourse.programId || null;

  const course = {
    id: `course-${Date.now()}`,
    code,
    title,
    lecturerId: sanitizeText(body.lecturerId) || data.users.find((user) => user.role === "lecturer")?.id || "u-lecturer-1",
    department: sanitizeText(body.department || "ICT"),
    programId,
    parentCourseId: parentCourse ? parentCourse.id : null,
    progress: 0,
    color: "#2563eb",
    schedule: sanitizeText(body.schedule || "Not scheduled"),
    room: sanitizeText(body.room || "Virtual"),
    enrolled: 0
  };

  data.courses.push(course);
  writeData(data);
  sendJson(res, 201, { course, courses: data.courses });
}

function updateCourse(res, data, courseId, body, authUser) {
  const course = data.courses.find((item) => item.id === courseId);
  if (!course) {
    sendJson(res, 404, { error: "Course was not found." });
    return;
  }

  if (authUser.role === "lecturer" && course.lecturerId !== authUser.id) {
    sendJson(res, 403, { error: "You can only edit courses assigned to you." });
    return;
  }

  if (body.programId !== undefined) {
    const programId = sanitizeText(body.programId) || null;
    if (programId && !data.programs.some((program) => program.id === programId)) {
      sendJson(res, 400, { error: "Program was not found." });
      return;
    }
    course.programId = programId;
  }

  if (body.parentCourseId !== undefined) {
    const parentId = sanitizeText(body.parentCourseId) || null;
    if (parentId && (parentId === course.id || !data.courses.some((item) => item.id === parentId))) {
      sendJson(res, 400, { error: "Parent course was not found." });
      return;
    }
    course.parentCourseId = parentId;
  }

  if (body.lecturerId !== undefined) {
    const lecturerId = sanitizeText(body.lecturerId);
    const lecturer = data.users.find((user) => user.id === lecturerId && (user.role === "lecturer" || user.role === "admin"));
    if (!lecturer) {
      sendJson(res, 400, { error: "Reassignment target must be an existing lecturer or admin." });
      return;
    }
    course.lecturerId = lecturerId;
  }

  for (const field of ["title", "code", "schedule", "room", "nextUp", "department"]) {
    if (body[field] !== undefined) {
      const value = sanitizeText(body[field]);
      course[field] = field === "code" ? value.toUpperCase() : value;
    }
  }

  if (body.progress !== undefined) {
    const progress = Number(body.progress);
    if (Number.isFinite(progress)) course.progress = Math.max(0, Math.min(100, progress));
  }

  writeData(data);
  sendJson(res, 200, { course, courses: data.courses });
}

// Signed-out callers get the institution and the program list and nothing else:
// every collection comes back empty, so the user directory, courses, marks and
// submissions are never readable without a session. Signed-in callers get the
// full dataset minus password hashes and session tokens.
function publicState(data, auth) {
  const shaped = ensureDataShape(data);

  if (!auth) {
    const empty = {};
    for (const [key, value] of Object.entries(shaped)) {
      if (key === "sessions") continue;
      empty[key] = Array.isArray(value) ? [] : (value && typeof value === "object" ? {} : value);
    }
    empty.institution = shaped.institution;
    empty.programs = shaped.programs || [];
    empty.authenticated = false;
    return empty;
  }

  return {
    ...shaped,
    users: shaped.users.map(({ passwordHash, ...user }) => user),
    sessions: undefined,
    authenticated: true
  };
}

async function handleApi(req, res) {
  try {
    const data = readData();
    const body = await readBody(req);
    const clientIp = req.socket.remoteAddress || "unknown";
    const pathname = req.url.split("?")[0];
    const courseIdMatch = /^\/api\/courses\/([\w-]+)$/.exec(pathname);
    const userIdMatch = /^\/api\/users\/([\w-]+)$/.exec(pathname);
    const presentationIdMatch = /^\/api\/presentations\/([\w-]+)$/.exec(pathname);
    const messageIdMatch = /^\/api\/messages\/([\w-]+)$/.exec(pathname);

    if (req.method === "GET" && pathname === "/api/state") {
      sendJson(res, 200, publicState(data, authenticate(req, data)));
      return;
    }

    if (req.method === "POST" && pathname === "/api/login") {
      const loginKey = `login:${clientIp}`;
      if (isRateLimited(loginKey)) {
        sendJson(res, 429, { error: "Too many attempts. Please try again in a few minutes." });
        return;
      }
      const signedIn = await handleLogin(res, data, body);
      if (!signedIn) recordAttempt(loginKey);
      return;
    }

    if (req.method === "POST" && pathname === "/api/signup") {
      const signupKey = `signup:${clientIp}`;
      if (isRateLimited(signupKey)) {
        sendJson(res, 429, { error: "Too many attempts. Please try again in a few minutes." });
        return;
      }
      recordAttempt(signupKey);
      await handleSignup(res, data, body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/logout") {
      const auth = authenticate(req, data);
      if (auth) {
        data.sessions = (data.sessions || []).filter((session) => session.token !== auth.session.token);
        writeData(data);
      }
      sendJson(res, 200, { message: "Signed out." });
      return;
    }

    if (req.method === "POST" && pathname === "/api/attendance") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (auth.user.role === "student" && auth.user.id !== body.userId) {
        sendJson(res, 403, { error: "You can only mark your own attendance." });
        return;
      }
      addAttendance(res, data, body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/submissions") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (auth.user.id !== body.userId) {
        sendJson(res, 403, { error: "You can only submit your own work." });
        return;
      }
      submitAssignment(res, data, body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/discussions/reply") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (auth.user.id !== body.userId) {
        sendJson(res, 403, { error: "You can only post as yourself." });
        return;
      }
      addForumMessage(res, data, body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/courses") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      createCourse(res, data, body);
      return;
    }

    if (req.method === "PATCH" && courseIdMatch) {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      updateCourse(res, data, courseIdMatch[1], body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/programs") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      createProgram(res, data, body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/announcements") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      createAnnouncement(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/tutorials") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      createTutorial(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/materials") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      uploadMaterial(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/presentations") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      createPresentation(res, data, body, auth.user);
      return;
    }

    if (req.method === "PATCH" && presentationIdMatch) {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      updatePresentation(res, data, presentationIdMatch[1], body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/messages") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (auth.user.id !== body.senderId) {
        sendJson(res, 403, { error: "You can only send messages as yourself." });
        return;
      }
      sendMessage(res, data, body, auth.user);
      return;
    }

    if (req.method === "GET" && pathname === "/api/messages") {
      const auth = requireSession(req, res, data); if (!auth) return;
      listMyMessages(res, data, auth.user);
      return;
    }

    if (req.method === "PATCH" && messageIdMatch) {
      const auth = requireSession(req, res, data); if (!auth) return;
      updateMessageReadState(res, data, messageIdMatch[1], body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/admin/users") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, ["admin"])) return;
      await createStaffUser(res, data, body);
      return;
    }

    if (req.method === "PATCH" && pathname === "/api/profile") {
      const auth = requireSession(req, res, data); if (!auth) return;
      await updateOwnProfile(res, data, auth.user, body);
      return;
    }

    if (req.method === "PATCH" && userIdMatch) {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, ["admin"])) return;
      await updateUserRecord(res, data, userIdMatch[1], body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/assignments") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      createAssignment(res, data, body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions/start") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      startClassSession(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions/schedule") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      scheduleClassSession(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions/begin") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      beginScheduledSession(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions/join") {
      const auth = requireSession(req, res, data); if (!auth) return;
      joinClassSession(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/sessions/end") {
      const auth = requireSession(req, res, data); if (!auth) return;
      if (!requireRole(auth, res, STAFF_ROLES)) return;
      endClassSession(res, data, body);
      return;
    }

    if (req.method === "POST" && pathname === "/api/studyrooms") {
      const auth = requireSession(req, res, data); if (!auth) return;
      createStudyRoom(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/studyrooms/join") {
      const auth = requireSession(req, res, data); if (!auth) return;
      joinStudyRoom(res, data, body, auth.user);
      return;
    }

    if (req.method === "POST" && pathname === "/api/studyrooms/close") {
      const auth = requireSession(req, res, data); if (!auth) return;
      closeStudyRoom(res, data, body, auth.user);
      return;
    }

    sendJson(res, 404, { error: "API route was not found." });
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
}

function serveStatic(req, res) {
  const cleanUrl = req.url.split("?")[0];
  const filePath = publicFilePath(cleanUrl);

  if (!filePath) {
    sendText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code === "ENOENT") {
        fs.readFile(path.join(PUBLIC_DIR, "index.html"), (indexError, indexContent) => {
          if (indexError) {
            sendText(res, 404, "Not found");
            return;
          }
          res.writeHead(200, { "content-type": mimeTypes[".html"] });
          res.end(indexContent);
        });
        return;
      }

      sendText(res, 500, "Unable to read file");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "content-type": mimeTypes[extension] || "application/octet-stream" });
    res.end(content);
  });
}

/* ============================== websocket (hand-rolled RFC 6455) ============================== */
// No new dependency: handshake uses crypto (already required above) for the accept-key
// digest, framing is implemented directly over the raw net.Socket handed to us by
// Node's 'upgrade' event. Text frames only (chat/whiteboard/presentation payloads all
// fit in a single small JSON frame) — no fragmentation or binary-frame support.

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const WS_MAX_FRAME_BYTES = 64 * 1024;

// channelId (a classSessions or studyRooms id) -> { members: Set<member>, strokes: [] }
// member: { socket, userId, role, name }
const wsChannels = new Map();
// userId -> Set<socket>, populated for every open /ws connection regardless of channel,
// used for message delivery pushes that aren't scoped to any live-room channel.
const wsUserSockets = new Map();

function wsEncodeFrame(payload, opcode = 0x1) {
  const payloadBuffer = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = payloadBuffer.length;
  let header;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payloadBuffer]);
}

function wsWrite(socket, buffer) {
  if (socket.destroyed || socket.writableEnded) return;
  try {
    socket.write(buffer);
  } catch (error) {
    // The socket may close between the destroyed-check and the write; safe to ignore.
  }
}

function wsSend(socket, message) {
  wsWrite(socket, wsEncodeFrame(JSON.stringify(message)));
}

function wsBroadcast(channelId, message, exceptSocket) {
  const channel = wsChannels.get(channelId);
  if (!channel) return;
  const frame = wsEncodeFrame(JSON.stringify(message));
  for (const member of channel.members) {
    if (member.socket === exceptSocket) continue;
    wsWrite(member.socket, frame);
  }
}

function wsSendToUser(userId, message) {
  const sockets = wsUserSockets.get(userId);
  if (!sockets) return;
  const frame = wsEncodeFrame(JSON.stringify(message));
  for (const socket of sockets) wsWrite(socket, frame);
}

function wsJoinChannel(channelId, member) {
  let channel = wsChannels.get(channelId);
  if (!channel) {
    channel = { members: new Set(), strokes: [] };
    wsChannels.set(channelId, channel);
  }
  channel.members.add(member);
  return channel;
}

function wsLeaveChannel(channelId, member) {
  const channel = wsChannels.get(channelId);
  if (!channel) return;
  channel.members.delete(member);
  if (channel.members.size === 0) wsChannels.delete(channelId);
}

// Called from the REST end/close handlers below — a board is scoped to one
// class/room's lifetime, not meant to persist into the next session.
function wsClearChannelBoard(channelId) {
  const channel = wsChannels.get(channelId);
  if (channel) channel.strokes = [];
}

function wsRegisterUserSocket(userId, socket) {
  let sockets = wsUserSockets.get(userId);
  if (!sockets) {
    sockets = new Set();
    wsUserSockets.set(userId, sockets);
  }
  sockets.add(socket);
}

function wsUnregisterUserSocket(userId, socket) {
  const sockets = wsUserSockets.get(userId);
  if (!sockets) return;
  sockets.delete(socket);
  if (sockets.size === 0) wsUserSockets.delete(userId);
}

// Mirrors the field-scoping already used for REST joins (joinClassSession/joinStudyRoom):
// a channel id is either a live class session or a study room, gated by canAccessCourse.
function canJoinWsChannel(data, user, channelId) {
  if (channelId.startsWith("session-")) {
    const session = data.classSessions.find((item) => item.id === channelId);
    if (!session) return false;
    return canAccessCourse(user, data.courses.find((item) => item.id === session.courseId));
  }
  if (channelId.startsWith("room-")) {
    const room = data.studyRooms.find((item) => item.id === channelId);
    if (!room) return false;
    return canAccessCourse(user, data.courses.find((item) => item.id === room.courseId));
  }
  return false;
}

// Parses as many complete frames as `buffer` currently holds; returns the frames found
// plus whatever incomplete trailing bytes should be retained for the next 'data' event.
function wsParseFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (true) {
    if (buffer.length - offset < 2) break;
    const byte0 = buffer[offset];
    const byte1 = buffer[offset + 1];
    const opcode = byte0 & 0x0f;
    const masked = Boolean(byte1 & 0x80);
    let length = byte1 & 0x7f;
    let pos = offset + 2;

    if (length === 126) {
      if (buffer.length - pos < 2) break;
      length = buffer.readUInt16BE(pos);
      pos += 2;
    } else if (length === 127) {
      if (buffer.length - pos < 8) break;
      length = Number(buffer.readBigUInt64BE(pos));
      pos += 8;
    }

    if (length > WS_MAX_FRAME_BYTES) {
      return { frames, remainder: Buffer.alloc(0), error: "too-large" };
    }

    let maskKey = null;
    if (masked) {
      if (buffer.length - pos < 4) break;
      maskKey = buffer.subarray(pos, pos + 4);
      pos += 4;
    }

    if (buffer.length - pos < length) break;
    let payload = buffer.subarray(pos, pos + length);
    if (masked) {
      const unmasked = Buffer.alloc(length);
      for (let i = 0; i < length; i++) unmasked[i] = payload[i] ^ maskKey[i % 4];
      payload = unmasked;
    }

    frames.push({ opcode, payload });
    offset = pos + length;
  }
  return { frames, remainder: buffer.subarray(offset), error: null };
}

// Dispatches one parsed client message. `channelId` is the channel the socket joined
// at handshake time (null for connections opened only for message delivery).
function handleWsMessage(user, channelId, message) {
  const type = message && message.type;
  const targetChannel = channelId || (typeof message?.channel === "string" ? message.channel : null);
  if (!targetChannel || !type) return;

  const envelope = {
    type,
    channel: targetChannel,
    from: { id: user.id, name: user.name, role: user.role },
    payload: message.payload && typeof message.payload === "object" ? message.payload : {},
    ts: Date.now()
  };

  if (type === "chat") {
    wsBroadcast(targetChannel, envelope);
    return;
  }

  if (type === "draw" || type === "clear") {
    const channel = wsChannels.get(targetChannel);
    if (channel) {
      if (type === "clear") channel.strokes = [];
      else {
        channel.strokes.push(envelope);
        if (channel.strokes.length > 500) channel.strokes.shift();
      }
    }
    wsBroadcast(targetChannel, envelope);
    return;
  }

  if (type === "slide") {
    const data = readData();
    const presentation = data.presentations.find((item) => item.id === envelope.payload.presentationId);
    if (!presentation || presentation.hostId !== user.id) return;
    const index = Number(envelope.payload.index);
    if (!Number.isInteger(index) || index < 0 || index >= presentation.slides.length) return;
    presentation.currentIndex = index;
    writeData(data);
    wsBroadcast(targetChannel, envelope);
  }
}

function handleUpgrade(req, socket) {
  let requestUrl;
  try {
    requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  } catch (error) {
    socket.destroy();
    return;
  }

  if (requestUrl.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const data = readData();
  const auth = resolveSessionToken(data, requestUrl.searchParams.get("token"));
  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const channelId = requestUrl.searchParams.get("channel") || null;
  // auth.user only carries {id, role, name, email}; program-scoped access checks need
  // the full record (programId), same lookup joinClassSession/joinStudyRoom already do.
  const fullUser = data.users.find((item) => item.id === auth.user.id) || auth.user;
  if (channelId && !canJoinWsChannel(data, fullUser, channelId)) {
    socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const acceptKey = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
    "Upgrade: websocket\r\n" +
    "Connection: Upgrade\r\n" +
    `Sec-WebSocket-Accept: ${acceptKey}\r\n\r\n`
  );

  const member = { socket, userId: auth.user.id, role: auth.user.role, name: auth.user.name };
  wsRegisterUserSocket(auth.user.id, socket);
  if (channelId) {
    const channel = wsJoinChannel(channelId, member);
    if (channel.strokes.length) {
      wsSend(socket, { type: "board-sync", channel: channelId, payload: { strokes: channel.strokes } });
    }
  }

  let buffered = Buffer.alloc(0);
  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    wsUnregisterUserSocket(auth.user.id, socket);
    if (channelId) wsLeaveChannel(channelId, member);
  };

  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const { frames, remainder, error } = wsParseFrames(buffered);
    buffered = remainder;
    if (error === "too-large") {
      socket.destroy();
      return;
    }

    for (const frame of frames) {
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }
      if (frame.opcode === 0x9) {
        wsWrite(socket, wsEncodeFrame(frame.payload, 0xA));
        continue;
      }
      if (frame.opcode !== 0x1) continue;

      let message;
      try {
        message = JSON.parse(frame.payload.toString("utf8"));
      } catch (error) {
        continue;
      }
      handleWsMessage(auth.user, channelId, message);
    }
  });

  socket.on("close", cleanup);
  socket.on("error", cleanup);
}

function createServer() {
  const server = http.createServer((req, res) => {
    applySecurityHeaders(res);
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      handleApi(req, res);
      return;
    }

    serveStatic(req, res);
  });
  server.on("upgrade", handleUpgrade);
  return server;
}

function startServer(port = PORT) {
  const server = createServer();
  server.listen(port, () => {
    console.log(`VFU E-Learning Classroom running at http://localhost:${port}`);
    getDbPool().catch(() => {});
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { createServer, startServer };

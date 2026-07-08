const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const mysql = require("mysql2/promise");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_FILE = path.join(ROOT, "data", "vfu-data.json");

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
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

function authenticate(req, data) {
  const match = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization || "").trim());
  if (!match) return null;
  const now = Date.now();
  const session = (data.sessions || []).find((item) => item.token === match[1] && item.expiresAt > now);
  if (!session) return null;
  return { user: { id: session.userId, role: session.role, name: session.name, email: session.email }, session };
}

const rateLimitBuckets = new Map();
function isRateLimited(key, limit = 10, windowMs = 5 * 60 * 1000) {
  const now = Date.now();
  const bucket = (rateLimitBuckets.get(key) || []).filter((ts) => now - ts < windowMs);
  bucket.push(now);
  rateLimitBuckets.set(key, bucket);
  return bucket.length > limit;
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
        student_number: null,
        staff_number: "VFU-ADM-2026-001",
        phone: "",
        avatar: "SA",
        password_hash: hashPassword("admin123")
      }
    ];

    for (const user of demoUsers) {
      await dbPool.query(
        `INSERT INTO users (id, name, email, role, program, student_number, staff_number, phone, avatar, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = VALUES(name),
           role = VALUES(role),
           program = VALUES(program),
           student_number = VALUES(student_number),
           staff_number = VALUES(staff_number),
           phone = VALUES(phone),
           avatar = VALUES(avatar),
           password_hash = VALUES(password_hash)`,
        [user.id, user.name, user.email, user.role, user.program, user.student_number, user.staff_number, user.phone, user.avatar, user.password_hash]
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
  users: [
    {
      id: "u-student-1",
      name: "Alex Likando",
      email: "student@vfu.local",
      role: "student",
      program: "BSc Information and Communication Technology",
      avatar: "AL",
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
  notifications: [],
  analytics: {
    activeStudents: 0,
    attendanceRate: 0,
    submissionRate: 0,
    averageGrade: 0,
    weeklyEngagement: [],
    courseCompletion: []
  }
};

function ensureDataShape(data) {
  const normalized = data && typeof data === "object" ? data : {};
  return {
    institution: normalized.institution || defaultData.institution,
    users: Array.isArray(normalized.users) ? normalized.users : [],
    courses: Array.isArray(normalized.courses) ? normalized.courses : [],
    classSessions: Array.isArray(normalized.classSessions) ? normalized.classSessions : [],
    attendance: Array.isArray(normalized.attendance) ? normalized.attendance : [],
    assignments: Array.isArray(normalized.assignments) ? normalized.assignments : [],
    submissions: Array.isArray(normalized.submissions) ? normalized.submissions : [],
    discussions: Array.isArray(normalized.discussions) ? normalized.discussions : [],
    notifications: Array.isArray(normalized.notifications) ? normalized.notifications : [],
    sessions: Array.isArray(normalized.sessions) ? normalized.sessions : [],
    analytics: normalized.analytics && typeof normalized.analytics === "object" ? normalized.analytics : defaultData.analytics
  };
}

function readData() {
  if (!fs.existsSync(DATA_FILE)) {
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

async function handleLogin(res, data, body) {
  const role = normalizeRole(body.role);
  const email = sanitizeText(body.email).toLowerCase();
  const password = String(body.password || "");

  if (!isValidEmail(email)) {
    sendJson(res, 400, { error: "Please provide a valid email address." });
    return;
  }

  const pool = await getDbPool();
  if (pool) {
    try {
      const [rows] = await pool.query("SELECT * FROM users WHERE email = ? AND role = ? LIMIT 1", [email, role]);
      const row = rows[0];
      if (row && verifyPassword(password, row.password_hash)) {
        const user = mapDbUser(row);
        sendJson(res, 200, { user, token: issueSession(data, user) });
        return;
      }
      sendJson(res, 401, { error: "Incorrect email, role, or password." });
      return;
    } catch (error) {
      console.warn("MySQL login lookup failed:", error.message);
    }
  }

  const fallbackUser = data.users.find(
    (candidate) => candidate.role === role && candidate.email.toLowerCase() === email
  );

  if (!fallbackUser || !verifyPassword(password, fallbackUser.passwordHash)) {
    sendJson(res, 401, { error: "Incorrect email, role, or password." });
    return;
  }

  sendJson(res, 200, { user: stripPasswordHash(fallbackUser), token: issueSession(data, fallbackUser) });
}

async function handleSignup(res, data, body) {
  const name = sanitizeText(body.name);
  const email = sanitizeText(body.email).toLowerCase();
  // Public self-registration is student-only. Elevated roles (lecturer/admin)
  // must be provisioned by an existing admin, not chosen by the signup caller —
  // otherwise anyone can register themselves as an admin.
  const role = "student";
  const password = String(body.password || "");

  if (!name || !email) {
    sendJson(res, 400, { error: "Name and email are required." });
    return;
  }

  if (!isValidEmail(email)) {
    sendJson(res, 400, { error: "Please provide a valid email address." });
    return;
  }

  const pwdError = validatePassword(password);
  if (pwdError) {
    sendJson(res, 400, { error: pwdError });
    return;
  }

  const pool = await getDbPool();
  if (pool) {
    try {
      const [existingRows] = await pool.query("SELECT id FROM users WHERE email = ? LIMIT 1", [email]);
      if (existingRows[0]) {
        sendJson(res, 409, { error: "An account with that email already exists." });
        return;
      }

      const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "VU";
      const userId = `u-${role}-${Date.now()}`;
      await pool.query(
        `INSERT INTO users (id, name, email, role, program, student_number, staff_number, phone, avatar, password_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [userId, name, email, role, sanitizeText(body.program || body.department || "VFU"), sanitizeText(body.studentNumber), sanitizeText(body.staffNumber), sanitizeText(body.phone), initials, hashPassword(password)]
      );

      const user = {
        id: userId,
        name,
        email,
        role,
        program: sanitizeText(body.program || body.department || "VFU"),
        studentNumber: sanitizeText(body.studentNumber),
        staffNumber: sanitizeText(body.staffNumber),
        phone: sanitizeText(body.phone),
        avatar: initials,
        createdAt: new Date().toISOString()
      };

      sendJson(res, 201, { user, token: issueSession(data, user) });
      return;
    } catch (error) {
      console.warn("MySQL signup insert failed:", error.message);
    }
  }

  if (data.users.some((candidate) => candidate.email.toLowerCase() === email)) {
    sendJson(res, 409, { error: "An account with that email already exists." });
    return;
  }

  const initials = name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "VU";
  const user = {
    id: `u-${role}-${Date.now()}`,
    name,
    email,
    role,
    program: sanitizeText(body.program || body.department || "VFU"),
    studentNumber: sanitizeText(body.studentNumber),
    staffNumber: sanitizeText(body.staffNumber),
    phone: sanitizeText(body.phone),
    avatar: initials,
    passwordHash: hashPassword(password),
    createdAt: new Date().toISOString()
  };

  data.users.push(user);
  writeData(data);
  sendJson(res, 201, { user: stripPasswordHash(user), token: issueSession(data, user) });
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

  if (!assignment || !user) {
    sendJson(res, 404, { error: "Assignment or user was not found." });
    return;
  }

  if (!text) {
    sendJson(res, 400, { error: "Submission text is required." });
    return;
  }

  const existing = data.submissions.find(
    (item) => item.assignmentId === assignment.id && item.userId === user.id
  );

  if (existing) {
    existing.text = text;
    existing.submittedAt = new Date().toISOString();
    existing.status = "Updated";
  } else {
    data.submissions.push({
      id: `sub-${Date.now()}`,
      assignmentId: assignment.id,
      courseId: assignment.courseId,
      userId: user.id,
      text,
      status: "Submitted",
      grade: null,
      submittedAt: new Date().toISOString()
    });
  }

  writeData(data);
  sendJson(res, 200, { submissions: data.submissions, message: "Assignment submitted." });
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

function createCourse(res, data, body) {
  const title = sanitizeText(body.title);
  const code = sanitizeText(body.code).toUpperCase();

  if (!title || !code) {
    sendJson(res, 400, { error: "Course title and code are required." });
    return;
  }

  const course = {
    id: `course-${Date.now()}`,
    code,
    title,
    lecturerId: sanitizeText(body.lecturerId) || data.users.find((user) => user.role === "lecturer")?.id || "u-lecturer-1",
    department: sanitizeText(body.department || "ICT"),
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

function publicState(data) {
  const shaped = ensureDataShape(data);
  return {
    ...shaped,
    users: shaped.users.map(({ passwordHash, ...user }) => user),
    sessions: undefined
  };
}

async function handleApi(req, res) {
  try {
    const data = readData();
    const body = await readBody(req);
    const clientIp = req.socket.remoteAddress || "unknown";

    if (req.method === "GET" && req.url === "/api/state") {
      sendJson(res, 200, publicState(data));
      return;
    }

    if (req.method === "POST" && req.url === "/api/login") {
      if (isRateLimited(`login:${clientIp}`)) {
        sendJson(res, 429, { error: "Too many attempts. Please try again in a few minutes." });
        return;
      }
      await handleLogin(res, data, body);
      return;
    }

    if (req.method === "POST" && req.url === "/api/signup") {
      if (isRateLimited(`signup:${clientIp}`)) {
        sendJson(res, 429, { error: "Too many attempts. Please try again in a few minutes." });
        return;
      }
      await handleSignup(res, data, body);
      return;
    }

    if (req.method === "POST" && req.url === "/api/logout") {
      const auth = authenticate(req, data);
      if (auth) {
        data.sessions = (data.sessions || []).filter((session) => session.token !== auth.session.token);
        writeData(data);
      }
      sendJson(res, 200, { message: "Signed out." });
      return;
    }

    if (req.method === "POST" && req.url === "/api/attendance") {
      const auth = authenticate(req, data);
      if (!auth) {
        sendJson(res, 401, { error: "Sign in required." });
        return;
      }
      if (auth.user.role === "student" && auth.user.id !== body.userId) {
        sendJson(res, 403, { error: "You can only mark your own attendance." });
        return;
      }
      addAttendance(res, data, body);
      return;
    }

    if (req.method === "POST" && req.url === "/api/submissions") {
      const auth = authenticate(req, data);
      if (!auth) {
        sendJson(res, 401, { error: "Sign in required." });
        return;
      }
      if (auth.user.id !== body.userId) {
        sendJson(res, 403, { error: "You can only submit your own work." });
        return;
      }
      submitAssignment(res, data, body);
      return;
    }

    if (req.method === "POST" && req.url === "/api/discussions/reply") {
      const auth = authenticate(req, data);
      if (!auth) {
        sendJson(res, 401, { error: "Sign in required." });
        return;
      }
      if (auth.user.id !== body.userId) {
        sendJson(res, 403, { error: "You can only post as yourself." });
        return;
      }
      addForumMessage(res, data, body);
      return;
    }

    if (req.method === "POST" && req.url === "/api/courses") {
      const auth = authenticate(req, data);
      if (!auth) {
        sendJson(res, 401, { error: "Sign in required." });
        return;
      }
      if (auth.user.role !== "lecturer" && auth.user.role !== "admin") {
        sendJson(res, 403, { error: "Only lecturers and admins can create courses." });
        return;
      }
      createCourse(res, data, body);
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

function createServer() {
  return http.createServer((req, res) => {
    applySecurityHeaders(res);
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    if (requestUrl.pathname.startsWith("/api/")) {
      handleApi(req, res);
      return;
    }

    serveStatic(req, res);
  });
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

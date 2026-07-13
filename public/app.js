
(() => {
  const originalFetch = window.fetch.bind(window);
  const storageKey = "vfu-offline-state";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const readState = () => JSON.parse(localStorage.getItem(storageKey) || JSON.stringify(clone(window.VFU_SEED_STATE)));
  const saveState = (data) => localStorage.setItem(storageKey, JSON.stringify(data));
  const initials = (name) => String(name || "VFU").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "VU";
  const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  const fieldFor = (value) => {
    const text = String(value || "").toLowerCase();
    if (/(ict|information|computer|software|network|technolog)/.test(text)) return "ICT";
    if (/(business|financial|account|management|marketing)/.test(text)) return "Business";
    return null;
  };
  const canAccess = (user, course) => {
    if (!user || user.role !== "student" || !course) return true;
    const sf = fieldFor(user.program), cf = fieldFor(course.department);
    return !sf || !cf || sf === cf;
  };

  const handleOffline = (path, method, body) => {
    const data = readState();
    if (!Array.isArray(data.studyRooms)) data.studyRooms = [];
    const actor = data.users.find((item) => item.id === body.userId) || null;

    if (method === "GET" && path === "/api/state") return jsonResponse(data);
    if (method === "POST" && path === "/api/login") {
      const role = String(body.role || "student").toLowerCase();
      const email = String(body.email || "").toLowerCase();
      const user = data.users.find((item) => item.role === role && item.email.toLowerCase() === email) || data.users.find((item) => item.role === role) || data.users[0];
      return jsonResponse({ user, token: `offline-${Date.now()}` });
    }
    if (method === "POST" && path === "/api/logout") return jsonResponse({ message: "Signed out." });
    if (method === "POST" && path === "/api/signup") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || data.users.some((user) => user.email.toLowerCase() === email)) return jsonResponse({ error: "Use a new valid email address." }, 400);
      // Public self-registration is student-only, matching the server.
      const user = { id: `u-student-${Date.now()}`, name: String(body.name || "New User").trim(), email, role: "student", program: String(body.program || body.department || "VFU").trim(), studentNumber: body.studentNumber || "", staffNumber: body.staffNumber || "", phone: body.phone || "", avatar: initials(body.name), createdAt: new Date().toISOString(), pendingBalance: 0 };
      data.users.push(user); saveState(data); return jsonResponse({ user, token: `offline-${Date.now()}` }, 201);
    }
    if (method === "POST" && path === "/api/attendance") {
      const session = data.classSessions.find((item) => item.id === body.sessionId);
      const exists = data.attendance.some((item) => item.sessionId === body.sessionId && item.userId === body.userId);
      if (session && !exists) { data.attendance.push({ id: `att-${Date.now()}`, sessionId: session.id, courseId: session.courseId, userId: body.userId, status: "Present", joinedAt: new Date().toISOString() }); saveState(data); }
      return jsonResponse({ attendance: data.attendance, message: "Attendance recorded." });
    }
    if (method === "POST" && path === "/api/sessions/start") {
      const course = data.courses.find((item) => item.id === body.courseId);
      if (!course) return jsonResponse({ error: "Course was not found." }, 404);
      if (data.classSessions.some((item) => item.courseId === course.id && item.status === "Live")) return jsonResponse({ error: "A live class is already running for this course." }, 409);
      const duration = Number(body.duration);
      const session = { id: `session-${Date.now()}`, courseId: course.id, title: String(body.title || "").trim() || `${course.title} live class`, startsAt: new Date().toISOString(), duration: duration > 0 ? Math.min(duration, 480) : 60, status: "Live", participants: 0, hostId: body.userId || "u-lecturer-1" };
      data.classSessions.push(session); saveState(data);
      return jsonResponse({ session, classSessions: data.classSessions }, 201);
    }
    if (method === "POST" && path === "/api/sessions/join") {
      const session = data.classSessions.find((item) => item.id === body.sessionId);
      if (!session) return jsonResponse({ error: "Class session was not found." }, 404);
      if (session.status !== "Live") return jsonResponse({ error: "This class is not live right now." }, 409);
      const course = data.courses.find((item) => item.id === session.courseId);
      if (!canAccess(actor, course)) return jsonResponse({ error: "This class is only open to students enrolled in its field." }, 403);
      if (actor && actor.role === "student" && !data.attendance.some((item) => item.sessionId === session.id && item.userId === actor.id)) {
        data.attendance.push({ id: `att-${Date.now()}`, sessionId: session.id, courseId: session.courseId, userId: actor.id, status: "Present", joinedAt: new Date().toISOString() });
        session.participants = Number(session.participants || 0) + 1;
        saveState(data);
      }
      return jsonResponse({ session, attendance: data.attendance, message: "Joined the live class." });
    }
    if (method === "POST" && path === "/api/sessions/end") {
      const session = data.classSessions.find((item) => item.id === body.sessionId);
      if (!session) return jsonResponse({ error: "Class session was not found." }, 404);
      if (session.status !== "Live") return jsonResponse({ error: "This class is not live." }, 409);
      session.status = "Ended"; session.endedAt = new Date().toISOString();
      const course = data.courses.find((item) => item.id === session.courseId);
      for (const user of data.users) {
        if (user.role !== "student" || !canAccess(user, course)) continue;
        if (!data.attendance.some((item) => item.sessionId === session.id && item.userId === user.id)) {
          data.attendance.push({ id: `att-${Date.now()}-${user.id}`, sessionId: session.id, courseId: session.courseId, userId: user.id, status: "Absent", joinedAt: null });
        }
      }
      saveState(data);
      return jsonResponse({ session, attendance: data.attendance, message: "Class ended. Missing students were marked absent." });
    }
    if (method === "POST" && path === "/api/submissions") {
      const assignment = data.assignments.find((item) => item.id === body.assignmentId);
      if (!assignment) return jsonResponse({ error: "Assignment was not found." }, 404);
      const text = String(body.text || "").trim();
      const fileName = String(body.fileName || "").trim();
      if (!text && !fileName) return jsonResponse({ error: "Submission text or an attached file is required." }, 400);
      const existing = data.submissions.find((item) => item.assignmentId === body.assignmentId && item.userId === body.userId);
      const fileFields = { fileName, fileType: String(body.fileType || ""), fileSize: Number(body.fileSize) || 0, fileData: typeof body.fileData === "string" && body.fileData.startsWith("data:") ? body.fileData : "" };
      if (existing) Object.assign(existing, { text, ...fileFields, status: "Submitted", submittedAt: new Date().toISOString() });
      else data.submissions.push({ id: `sub-${Date.now()}`, assignmentId: assignment.id, courseId: assignment.courseId, userId: body.userId, text, ...fileFields, status: "Submitted", grade: null, submittedAt: new Date().toISOString() });
      saveState(data); return jsonResponse({ submissions: data.submissions, message: "Assignment submitted." });
    }
    if (method === "POST" && path === "/api/assignments") {
      const course = data.courses.find((item) => item.id === body.courseId);
      const title = String(body.title || "").trim();
      if (!course || !title) return jsonResponse({ error: "A valid course and assignment title are required." }, 400);
      const due = new Date(body.dueAt || "");
      const assignment = { id: `assignment-${Date.now()}`, courseId: course.id, title, description: String(body.description || "").trim(), dueAt: Number.isNaN(due.getTime()) ? new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() : due.toISOString(), points: Number(body.points) > 0 ? Number(body.points) : 10, status: "Open" };
      data.assignments.push(assignment); saveState(data);
      return jsonResponse({ assignment, assignments: data.assignments }, 201);
    }
    if (method === "POST" && path === "/api/discussions/reply") {
      const discussion = data.discussions.find((item) => item.id === body.discussionId);
      const user = data.users.find((item) => item.id === body.userId);
      if (discussion && user) { discussion.replies.push({ id: `reply-${Date.now()}`, userId: user.id, author: user.name, text: String(body.text || "").trim(), createdAt: new Date().toISOString() }); saveState(data); }
      return jsonResponse({ discussions: data.discussions, message: "Reply posted." });
    }
    if (method === "POST" && path === "/api/studyrooms") {
      const course = data.courses.find((item) => item.id === body.courseId);
      const topic = String(body.topic || "").trim();
      if (!course || !topic) return jsonResponse({ error: "A valid course and study topic are required." }, 400);
      if (!canAccess(actor, course)) return jsonResponse({ error: "You can only open study rooms for courses in your field." }, 403);
      const room = { id: `room-${Date.now()}`, courseId: course.id, topic, hostId: actor?.id || body.userId, hostName: actor?.name || "Student", status: "Open", createdAt: new Date().toISOString(), members: [actor?.id || body.userId] };
      data.studyRooms.push(room); saveState(data);
      return jsonResponse({ room, studyRooms: data.studyRooms }, 201);
    }
    if (method === "POST" && path === "/api/studyrooms/join") {
      const room = data.studyRooms.find((item) => item.id === body.roomId);
      if (!room || room.status !== "Open") return jsonResponse({ error: "Study room is not open." }, 404);
      const course = data.courses.find((item) => item.id === room.courseId);
      if (!canAccess(actor, course)) return jsonResponse({ error: "This room is private to students of its course field." }, 403);
      if (actor && !room.members.includes(actor.id)) { room.members.push(actor.id); saveState(data); }
      return jsonResponse({ room, studyRooms: data.studyRooms });
    }
    if (method === "POST" && path === "/api/studyrooms/close") {
      const room = data.studyRooms.find((item) => item.id === body.roomId);
      if (!room) return jsonResponse({ error: "Study room was not found." }, 404);
      room.status = "Closed"; saveState(data);
      return jsonResponse({ room, studyRooms: data.studyRooms });
    }
    if (method === "POST" && path === "/api/courses") {
      data.courses.push({ id: `course-${Date.now()}`, code: String(body.code || "").toUpperCase(), title: String(body.title || ""), lecturerId: body.lecturerId || "u-lecturer-1", department: body.department || "ICT", progress: 0, color: "#2563eb", schedule: body.schedule || "Not scheduled", nextUp: "Week 1 - Introduction", room: "Virtual", enrolled: 0 });
      saveState(data); return jsonResponse({ courses: data.courses });
    }
    return jsonResponse({ error: "Offline API route was not found." }, 404);
  };

  // Offline mode serves the whole API from localStorage (seeded from VFU_SEED_STATE).
  // It engages when there is no JSON backend to talk to: opened as a file:// page, or
  // hosted statically (e.g. Vercel) where /api/* is not answered by our Node server.
  // Served mode (npm start / Render) hits the real server and this shim stays out of the way.
  let backendAvailable = window.location.protocol === "file:" ? false : null;

  window.fetch = async (resource, options = {}) => {
    const path = String(resource);
    if (!path.startsWith("/api/")) return originalFetch(resource, options);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : {};

    if (backendAvailable === false) return handleOffline(path, method, body);

    try {
      const response = await originalFetch(resource, options);
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.includes("application/json")) {
        backendAvailable = false;
        return handleOffline(path, method, body);
      }
      backendAvailable = true;
      return response;
    } catch (error) {
      backendAvailable = false;
      return handleOffline(path, method, body);
    }
  };
})();

/* ============================== app state ============================== */

const routes = [
  { id: "dashboard", label: "Dashboard", icon: "layout" }, { id: "courses", label: "My Courses", icon: "book" },
  { id: "classroom", label: "Live Room", icon: "video" }, { id: "attendance", label: "Attendance", icon: "check" },
  { id: "assignments", label: "Assignments", icon: "file" }, { id: "discussions", label: "Group Study", icon: "messages" },
  { id: "analytics", label: "Analytics", icon: "chart" }, { id: "admin", label: "Admin", icon: "settings" }
];
const roleLabels = { student: "Student", lecturer: "Lecturer", admin: "Admin" };
const sessionKey = "vfu-session";
const themeKey = "vfu-theme";
const usageKey = "vfu-usage";

let state = null, currentRoute = "dashboard", currentUser = null, query = "", authMode = "login", authRole = "student";
let localStream = null, screenStream = null;
const liveRoom = { sessionId: null, mic: true, camera: true, screen: false, hand: false, panel: "chat", messages: [], mediaError: "" };
const studyState = { roomId: null, messages: [] };
const openAssignments = new Set();
const pendingFiles = {};

/* ============================== dom + icons ============================== */

const viewRoot = document.querySelector("#viewRoot"), navList = document.querySelector("#navList"), sessionPanel = document.querySelector("#sessionPanel"), profileCard = document.querySelector("#profileCard"), pageTitle = document.querySelector("#pageTitle"), termLabel = document.querySelector("#termLabel"), notificationCount = document.querySelector("#notificationCount"), notificationButton = document.querySelector("#notificationButton"), noticeStack = document.querySelector("#noticeStack"), themeSwitch = document.querySelector("#themeSwitch");

const iconPaths = {
  layout: "<rect x='3' y='3' width='7' height='7'></rect><rect x='14' y='3' width='7' height='7'></rect><rect x='14' y='14' width='7' height='7'></rect><rect x='3' y='14' width='7' height='7'></rect>",
  book: "<path d='M4 19.5A2.5 2.5 0 0 1 6.5 17H20'></path><path d='M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z'></path>",
  video: "<path d='M23 7l-7 5 7 5V7z'></path><rect x='1' y='5' width='15' height='14' rx='2'></rect>",
  check: "<path d='M20 6L9 17l-5-5'></path>",
  file: "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'></path><path d='M14 2v6h6'></path><path d='M8 13h8'></path><path d='M8 17h6'></path>",
  messages: "<path d='M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'></path>",
  chart: "<path d='M3 3v18h18'></path><rect x='7' y='12' width='3' height='5'></rect><rect x='12' y='8' width='3' height='9'></rect><rect x='17' y='5' width='3' height='12'></rect>",
  settings: "<circle cx='12' cy='12' r='3'></circle><path d='M19 15a2 2 0 0 0 .4 2l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a2 2 0 0 0-2-.4 2 2 0 0 0-1.2 1.8V21a2 2 0 1 1-4 0v-.2a2 2 0 0 0-1.2-1.8 2 2 0 0 0-2 .4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a2 2 0 0 0 .4-2 2 2 0 0 0-1.8-1.2H3a2 2 0 1 1 0-4h.2A2 2 0 0 0 5 8.2a2 2 0 0 0-.4-2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a2 2 0 0 0 2 .4A2 2 0 0 0 10.6 2H11a2 2 0 1 1 4 0v.2a2 2 0 0 0 1.2 1.8 2 2 0 0 0 2-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a2 2 0 0 0-.4 2 2 2 0 0 0 1.8 1.2H21a2 2 0 1 1 0 4h-.2A2 2 0 0 0 19 15z'></path>",
  bell: "<path d='M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7'></path><path d='M13.73 21a2 2 0 0 1-3.46 0'></path>",
  plus: "<path d='M12 5v14'></path><path d='M5 12h14'></path>",
  send: "<path d='M22 2L11 13'></path><path d='M22 2l-7 20-4-9-9-4 20-7z'></path>",
  upload: "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'></path><path d='M17 8l-5-5-5 5'></path><path d='M12 3v12'></path>",
  mic: "<path d='M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z'></path><path d='M19 10v2a7 7 0 0 1-14 0v-2'></path><path d='M12 19v4'></path><path d='M8 23h8'></path>",
  micOff: "<path d='M1 1l22 22'></path><path d='M9 9v3a3 3 0 0 0 5 2'></path><path d='M15 9V4a3 3 0 0 0-6 0v1'></path><path d='M19 10v2a7 7 0 0 1-.5 2.6'></path><path d='M12 19v4'></path>",
  screen: "<rect x='2' y='3' width='20' height='14' rx='2'></rect><path d='M8 21h8'></path><path d='M12 17v4'></path>",
  leave: "<path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'></path><path d='M16 17l5-5-5-5'></path><path d='M21 12H9'></path>",
  hand: "<path d='M18 11V6a2 2 0 0 0-4 0v5'></path><path d='M14 10V4a2 2 0 0 0-4 0v8'></path><path d='M10 10.5V5a2 2 0 0 0-4 0v9'></path><path d='M6 13l-1.6-1.6a2 2 0 0 0-2.8 2.8l5.2 5.2A8 8 0 0 0 20 14v-3a2 2 0 1 0-4 0'></path>",
  users: "<path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'></path><circle cx='9' cy='7' r='4'></circle><path d='M23 21v-2a4 4 0 0 0-3-3.87'></path><path d='M16 3.13a4 4 0 0 1 0 7.75'></path>",
  logout: "<path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'></path><path d='M16 17l5-5-5-5'></path><path d='M21 12H9'></path>",
  clock: "<circle cx='12' cy='12' r='10'></circle><path d='M12 6v6l4 2'></path>",
  wallet: "<path d='M21 12V7H5a2 2 0 0 1 0-4h14v4'></path><path d='M3 5v14a2 2 0 0 0 2 2h16v-5'></path><path d='M18 12a2 2 0 0 0 0 4h4v-4z'></path>"
};
const icon = (name) => `<svg aria-hidden="true" viewBox="0 0 24 24">${iconPaths[name] || iconPaths.layout}</svg>`;

/* ============================== helpers ============================== */

const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const formatDateTime = (value) => value ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "";
const formatDay = (value) => value ? new Intl.DateTimeFormat("en", { day: "numeric", month: "long", year: "numeric" }).format(new Date(value)) : "Not recorded";
const courseById = (id) => state.courses.find((course) => course.id === id);
const userById = (id) => state.users.find((user) => user.id === id);
const currentRole = () => currentUser?.role || authRole;
const visibleRoutes = () => !currentUser ? [] : currentRole() === "student" ? routes.filter((route) => route.id !== "admin") : routes;
const matchesQuery = (text) => String(text).toLowerCase().includes(query.trim().toLowerCase());
const readSession = () => { try { return JSON.parse(localStorage.getItem(sessionKey) || "null"); } catch { return null; } };
const saveSession = (session) => localStorage.setItem(sessionKey, JSON.stringify(session));
const clearSession = () => localStorage.removeItem(sessionKey);

function fieldForProgram(value) {
  const text = String(value || "").toLowerCase();
  if (/(ict|information|computer|software|network|technolog)/.test(text)) return "ICT";
  if (/(business|financial|account|management|marketing)/.test(text)) return "Business";
  return null;
}

function canAccessCourse(user, course) {
  if (!user || user.role !== "student" || !course) return true;
  const studentField = fieldForProgram(user.program);
  const courseField = fieldForProgram(course.department);
  return !studentField || !courseField || studentField === courseField;
}

function myCourses() {
  if (!currentUser) return state.courses;
  if (currentUser.role === "student") return state.courses.filter((course) => canAccessCourse(currentUser, course));
  if (currentUser.role === "lecturer") {
    const own = state.courses.filter((course) => course.lecturerId === currentUser.id);
    return own.length ? own : state.courses;
  }
  return state.courses;
}

function mySessions() {
  const ids = new Set(myCourses().map((course) => course.id));
  return state.classSessions.filter((session) => ids.has(session.courseId));
}

async function api(path, options = {}) {
  const session = readSession();
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (session?.token) headers.authorization = `Bearer ${session.token}`;
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

function showToast(message, tone = "success") {
  const toast = document.createElement("div"); toast.className = `toast ${tone}`; toast.textContent = message; noticeStack.append(toast); setTimeout(() => toast.remove(), 3600);
}

function emptyState(title = "Nothing here yet", detail = "Check back soon or try a different search.") {
  return `<div class="empty-state"><div class="empty-visual" aria-hidden="true"></div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(detail)}</p></div>`;
}

function metricCard(label, value, detail, iconName = "chart") {
  return `<article class="metric"><span class="metric-icon">${icon(iconName)}</span><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p class="eyebrow">${escapeHtml(detail)}</p></article>`;
}

function gauge(fraction, display, label) {
  const len = 100.5;
  const clamped = Math.max(0, Math.min(1, fraction || 0));
  return `<div class="gauge-item"><svg viewBox="0 0 80 48" aria-hidden="true"><path class="gauge-track" d="M8 42 A 32 32 0 0 1 72 42" fill="none" stroke-width="8" stroke-linecap="round"></path><path class="gauge-value" d="M8 42 A 32 32 0 0 1 72 42" fill="none" stroke-width="8" stroke-linecap="round" stroke-dasharray="${(clamped * len).toFixed(1)} ${len}"></path></svg><strong>${escapeHtml(display)}</strong><small>${escapeHtml(label)}</small></div>`;
}

/* ============================== theme ============================== */

function applyTheme(name, persist = true) {
  const theme = ["dark", "light", "ocean"].includes(name) ? name : "dark";
  document.documentElement.dataset.theme = theme;
  if (persist) localStorage.setItem(themeKey, theme);
  themeSwitch?.querySelectorAll(".theme-dot").forEach((dot) => dot.classList.toggle("active", dot.dataset.themeSet === theme));
}

/* ============================== media (WebRTC device capture) ============================== */

async function startLocalMedia() {
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    liveRoom.mediaError = "";
    applyTrackStates();
  } catch (error) {
    localStream = null;
    liveRoom.mediaError = "Camera or microphone was not available. You are connected in view-only mode.";
  }
}

function applyTrackStates() {
  if (!localStream) return;
  localStream.getAudioTracks().forEach((track) => { track.enabled = liveRoom.mic; });
  localStream.getVideoTracks().forEach((track) => { track.enabled = liveRoom.camera; });
}

function stopMedia() {
  [localStream, screenStream].forEach((stream) => stream?.getTracks().forEach((track) => track.stop()));
  localStream = null; screenStream = null; liveRoom.screen = false;
}

async function toggleScreenShare() {
  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null; liveRoom.screen = false;
  } else {
    try {
      screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
      liveRoom.screen = true;
      screenStream.getVideoTracks()[0]?.addEventListener("ended", () => { screenStream = null; liveRoom.screen = false; render(); });
    } catch { liveRoom.screen = false; }
  }
  render();
}

function afterRender() {
  const localVideo = document.getElementById("localVideo");
  if (localVideo && localStream) localVideo.srcObject = localStream;
  const screenVideo = document.getElementById("screenVideo");
  if (screenVideo && screenStream) screenVideo.srcObject = screenStream;
  const chat = viewRoot.querySelector(".chat-stream");
  if (chat) chat.scrollTop = chat.scrollHeight;
}

/* ============================== auth view ============================== */

function renderAuth() {
  pageTitle.textContent = "Welcome";
  const isLogin = authMode === "login";
  return `<section class="auth-layout">
    <div class="auth-visual"><span class="brand-mark">V</span><p class="eyebrow">${escapeHtml(state.institution.term)}</p><h1>${escapeHtml(state.institution.name)}</h1><p>${escapeHtml(state.institution.tagline)}</p><div class="auth-feature-grid"><span>${icon("video")} Live classes</span><span>${icon("check")} Auto attendance</span><span>${icon("messages")} Group study</span><span>${icon("chart")} Analytics</span></div></div>
    <div class="auth-panel"><div class="auth-tabs" role="tablist" aria-label="Authentication options"><button class="${isLogin ? "active" : ""}" type="button" data-auth-mode="login">Login</button><button class="${!isLogin ? "active" : ""}" type="button" data-auth-mode="signup-student">Student sign up</button></div>
    <form class="auth-form" id="authForm" data-mode="${authMode}"><div><p class="eyebrow">${isLogin ? "Secure access" : "Learner registration"}</p><h2>${isLogin ? "Sign in to your classroom" : "Create your student account"}</h2></div>
      ${isLogin ? `<label>Role<select name="role" id="loginRole"><option value="student" ${authRole === "student" ? "selected" : ""}>Student</option><option value="lecturer" ${authRole === "lecturer" ? "selected" : ""}>Lecturer</option><option value="admin" ${authRole === "admin" ? "selected" : ""}>Admin</option></select></label>` : `<input type="hidden" name="role" value="student"><label>Full name<input name="name" required placeholder="Enter full name"></label>`}
      <label>Email<input name="email" type="email" required autocomplete="off" placeholder="name@vfu.edu"></label><label>Password<input name="password" type="password" required minlength="6" autocomplete="off" placeholder="Enter your password"></label>
      ${!isLogin ? `<div class="field-grid"><label>Student number<input name="studentNumber" required placeholder="VFU-ST-2026-001"></label><label>Program<select name="program"><option>BSc Information and Communication Technology</option><option>BSc Business and Financial Management</option><option>Diploma in ICT</option></select></label></div><label>Phone<input name="phone" placeholder="Optional"></label>` : ""}
      <button class="action primary wide" type="submit">${icon(isLogin ? "logout" : "plus")} ${isLogin ? "Login" : "Create account"}</button>${isLogin ? `<p class="auth-note">Select your role, then enter the email and password provided to you.</p>` : ""}
    </form></div></section>`;
}

/* ============================== dashboard ============================== */

function myAttendanceStats() {
  const mine = state.attendance.filter((item) => item.userId === currentUser.id);
  const present = mine.filter((item) => item.status === "Present").length;
  const absent = mine.filter((item) => item.status === "Absent").length;
  const rate = present + absent ? Math.round((present / (present + absent)) * 100) : 100;
  return { mine, present, absent, rate };
}

function myGpa() {
  const graded = state.submissions.filter((item) => item.userId === currentUser.id && item.grade != null);
  if (!graded.length) return null;
  const avg = graded.reduce((acc, item) => {
    const assignment = state.assignments.find((entry) => entry.id === item.assignmentId);
    return acc + (assignment?.points ? item.grade / assignment.points : 0);
  }, 0) / graded.length;
  return Math.round(avg * 4 * 10) / 10;
}

function renderCourseCards(courses, withActions) {
  if (!courses.length) return emptyState("No courses in your field yet", "Courses appear here once they are created for your program.");
  return courses.map((course) => {
    const lecturer = userById(course.lecturerId);
    return `<article class="course-card" style="--course-color: ${escapeHtml(course.color || "#2563eb")};">
      <div class="course-cover"><span>${escapeHtml(course.code)}</span></div>
      <div class="course-body">
        <h3>${escapeHtml(course.title)}</h3>
        <p class="lecturer-line"><span>${escapeHtml(lecturer?.name || "VFU Faculty")}</span><span>${course.progress || 0}%</span></p>
        <div class="progress" aria-label="${course.progress || 0}% complete"><span style="--value: ${course.progress || 0}%"></span></div>
        <p class="next-up">Next Up: <strong>${escapeHtml(course.nextUp || course.schedule || "To be announced")}</strong></p>
        ${withActions ? `<button class="action primary" type="button" data-route-jump="classroom">${icon("video")} Go to Class</button>` : ""}
      </div>
    </article>`;
  }).join("");
}

function renderDashboard() {
  const courses = myCourses();
  const courseIds = new Set(courses.map((course) => course.id));
  const now = Date.now();
  const deadlines = state.assignments
    .filter((item) => item.status === "Open" && courseIds.has(item.courseId) && new Date(item.dueAt).getTime() > now - 24 * 60 * 60 * 1000)
    .sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt))
    .slice(0, 5);
  const live = mySessions().find((session) => session.status === "Live");
  const stats = currentRole() === "student" ? myAttendanceStats() : null;
  const gpa = currentRole() === "student" ? myGpa() : null;
  const completed = courses.filter((course) => (course.progress || 0) >= 100).length;

  const feedItems = [
    ...state.notifications.map((note) => ({ icon: note.type === "assignment" ? "file" : "bell", title: note.title, body: note.body })),
    ...state.discussions.flatMap((discussion) => discussion.replies.slice(-1).map((reply) => ({ icon: "messages", title: `${reply.author} replied`, body: discussion.title })))
  ].slice(0, 5);

  const firstName = String(currentUser.name || "there").split(/\s+/)[0];
  const today = new Intl.DateTimeFormat("en", { weekday: "long", month: "long", day: "numeric", year: "numeric" }).format(new Date());

  return `<section class="welcome-banner"><div><h2>Welcome Back, ${escapeHtml(firstName)}! 👋</h2><p>${escapeHtml(today)} | ${escapeHtml(state.institution.term)}</p></div>${live ? `<button class="action primary" type="button" data-route-jump="classroom"><span class="live-dot"></span> Join live class</button>` : `<span class="status-pill">${escapeHtml(roleLabels[currentRole()] || currentRole())}</span>`}</section>
  <div class="dash-grid">
    <div class="dash-main">
      <section class="panel"><div class="section-head"><h2>My Courses</h2><span class="status-pill">${courses.length} active</span></div><div class="grid course-grid">${renderCourseCards(courses, currentRole() === "student")}</div></section>
      <section class="panel"><div class="section-head"><h2>Activity Feed</h2></div><div class="feed-list">${feedItems.length ? feedItems.map((item) => `<article class="feed-item"><span class="icon-dot">${icon(item.icon)}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(item.body)}</p></div></article>`).join("") : emptyState("No recent activity")}</div></section>
    </div>
    <div class="dash-side">
      <section class="panel"><div class="section-head"><h2>Upcoming Deadlines</h2></div><div class="deadline-list">${deadlines.length ? deadlines.map((item) => `<article class="deadline-item"><span class="icon-dot">${icon("clock")}</span><div><strong>${escapeHtml(item.title)}</strong><p>${escapeHtml(courseById(item.courseId)?.title || "Course")} | Due ${formatDateTime(item.dueAt)}</p></div></article>`).join("") : emptyState("No upcoming deadlines", "New assignments will show up here.")}</div></section>
      <section class="panel"><div class="section-head"><h2>Progress Overview</h2></div><div class="gauge-row">
        ${gauge(gpa != null ? gpa / 4 : 0, gpa != null ? `GPA ${gpa.toFixed(1)}` : "GPA -", "Graded work")}
        ${gauge(courses.length ? completed / courses.length : 0, `${completed}/${courses.length}`, "Courses complete")}
        ${gauge(stats ? stats.rate / 100 : (state.analytics.attendanceRate || 0) / 100, `${stats ? stats.rate : state.analytics.attendanceRate}%`, "Attendance")}
      </div></section>
    </div>
  </div>`;
}

/* ============================== courses ============================== */

function renderCourses() {
  const courses = myCourses().filter((course) => matchesQuery(`${course.code} ${course.title} ${course.department}`));
  const sessions = mySessions();
  const highlight = sessions.find((session) => session.status === "Live") || sessions.filter((session) => session.status === "Scheduled").sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt))[0];
  const highlightCourse = highlight ? courseById(highlight.courseId) : null;
  return `<div class="courses-layout">
    <section class="panel"><div class="section-head"><h2>My Courses</h2>${currentRole() !== "student" ? `<button class="action primary" type="button" data-route-jump="admin">${icon("plus")} Add course</button>` : `<span class="status-pill">${escapeHtml(fieldForProgram(currentUser.program) || "All fields")}</span>`}</div><div class="grid course-grid">${renderCourseCards(courses, false)}</div></section>
    <aside class="panel"><div class="section-head"><h2>Live and upcoming</h2></div>${highlight && highlightCourse ? `<div class="live-next-card"><span class="live-pill ${highlight.status === "Live" ? "on" : ""}">${highlight.status === "Live" ? `<span class="live-dot"></span> Live now` : "Scheduled"}</span><h3>${escapeHtml(highlight.title)}</h3><p>${escapeHtml(highlightCourse.code)} | ${escapeHtml(highlightCourse.title)}</p><p>${formatDateTime(highlight.startsAt)} | ${highlight.duration} min</p>${highlight.status === "Live" ? `<button class="action primary wide" type="button" data-route-jump="classroom">${icon("video")} Open Live Room</button>` : `<p class="mini-note">The Live Room opens when the lecturer starts this class.</p>`}</div>` : `<div class="mini-note">No live or scheduled class for your courses right now. Your lecturer schedules classes here.</div>`}</aside>
  </div>`;
}

/* ============================== live room ============================== */

function sessionParticipants(session) {
  const present = state.attendance.filter((item) => item.sessionId === session.id && item.status === "Present").map((item) => userById(item.userId)).filter(Boolean);
  const host = userById(session.hostId) || userById(courseById(session.courseId)?.lecturerId);
  const all = host ? [host, ...present.filter((user) => user.id !== host.id)] : present;
  return all;
}

function renderJoinedRoom(session, course, isStudyRoom, roomMembers) {
  const participants = isStudyRoom ? roomMembers : sessionParticipants(session);
  const others = participants.filter((user) => user.id !== currentUser.id);
  const isHost = !isStudyRoom && (session.hostId === currentUser.id || currentRole() !== "student");
  const messages = isStudyRoom ? studyState.messages : liveRoom.messages;
  const primaryTile = liveRoom.screen
    ? `<div class="video-tile primary-tile"><video id="screenVideo" autoplay playsinline muted></video><span class="tile-name">Screen share</span></div>`
    : `<div class="video-tile primary-tile">${localStream && liveRoom.camera ? `<video id="localVideo" autoplay playsinline muted></video>` : `<div class="tile-placeholder"><span class="avatar">${escapeHtml(currentUser.avatar)}</span><strong>${escapeHtml(currentUser.name)}</strong><small>${liveRoom.mediaError ? "View-only mode" : "Camera is off"}</small></div>`}<span class="tile-name">${escapeHtml(currentUser.name)} (You)${liveRoom.hand ? " ✋" : ""}</span></div>`;
  const hiddenLocal = liveRoom.screen && localStream && liveRoom.camera ? `<div class="video-tile"><video id="localVideo" autoplay playsinline muted></video><span class="tile-name">${escapeHtml(currentUser.name)} (You)</span></div>` : "";

  return `<section class="live-shell">
    <div class="live-stage">
      <div class="live-topbar"><div><p class="eyebrow">${escapeHtml(course?.code || "VFU")} | ${escapeHtml(course?.title || "Virtual Classroom")}</p><h2>${escapeHtml(isStudyRoom ? session.topic : session.title)}</h2></div><span class="live-pill on"><span class="live-dot"></span> ${isStudyRoom ? "Study room" : "Live"}</span></div>
      <div class="video-grid">${primaryTile}${hiddenLocal}${others.map((user) => `<div class="video-tile"><div class="tile-placeholder"><span class="avatar">${escapeHtml(user.avatar || initialsOf(user.name))}</span><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(roleLabels[user.role] || user.role)}</small></div></div>`).join("")}</div>
      ${liveRoom.mediaError ? `<div class="mini-note">${escapeHtml(liveRoom.mediaError)}</div>` : ""}
      <div class="control-bar" aria-label="Live controls">
        <button class="ctrl-button ${liveRoom.mic ? "" : "active"}" type="button" data-live-action="mic">${icon(liveRoom.mic ? "mic" : "micOff")}<span>${liveRoom.mic ? "Mute" : "Unmute"}</span></button>
        <button class="ctrl-button ${liveRoom.camera ? "" : "active"}" type="button" data-live-action="camera">${icon("video")}<span>${liveRoom.camera ? "Stop Video" : "Start Video"}</span></button>
        <button class="ctrl-button ${liveRoom.screen ? "active" : ""}" type="button" data-live-action="screen">${icon("screen")}<span>${liveRoom.screen ? "Stop Share" : "Share Screen"}</span></button>
        ${!isStudyRoom ? `<button class="ctrl-button ${liveRoom.hand ? "active" : ""}" type="button" data-live-action="hand">${icon("hand")}<span>${liveRoom.hand ? "Lower Hand" : "Raise Hand"}</span></button>` : ""}
        ${isStudyRoom ? `<button class="ctrl-button danger" type="button" data-study-leave>${icon("leave")}<span>Leave Room</span></button>` : `<button class="ctrl-button danger" type="button" data-live-leave>${icon("leave")}<span>Leave Class</span></button>`}
        ${isStudyRoom && session.hostId === currentUser.id ? `<button class="ctrl-button danger" type="button" data-study-close="${escapeHtml(session.id)}">${icon("leave")}<span>Close Room</span></button>` : ""}
        ${isHost ? `<button class="ctrl-button danger" type="button" data-live-end="${escapeHtml(session.id)}">${icon("leave")}<span>End Class</span></button>` : ""}
      </div>
    </div>
    <aside class="live-side panel">
      <div class="live-tabs">
        <button class="panel-tab ${liveRoom.panel === "chat" ? "active" : ""}" type="button" data-live-panel="chat">${icon("messages")} Chat</button>
        <button class="panel-tab ${liveRoom.panel === "people" ? "active" : ""}" type="button" data-live-panel="people">${icon("users")} Participants (${participants.length})</button>
      </div>
      ${liveRoom.panel === "people"
        ? `<div class="live-side-body"><div class="participant-list">${participants.map((user) => `<article><span class="avatar">${escapeHtml(user.avatar || initialsOf(user.name))}</span><div><strong>${escapeHtml(user.name)}${user.id === currentUser.id ? " (You)" : ""}</strong><p>${escapeHtml(roleLabels[user.role] || user.role)}</p></div><span class="presence"></span></article>`).join("")}</div><p class="mini-note">Media runs on WebRTC device capture in your browser.</p></div>`
        : `<div class="live-side-body"><div class="chat-stream">${messages.length ? messages.map((message) => `<article class="chat-message"><strong>${escapeHtml(message.author)}</strong><p>${escapeHtml(message.text)}</p></article>`).join("") : `<p class="mini-note">No messages yet. Say hello to the room.</p>`}</div><form class="compose inline" id="chatForm"><input name="message" placeholder="Message the room" autocomplete="off"><button class="action primary" type="submit" title="Send message">${icon("send")}</button></form></div>`}
    </aside>
  </section>`;
}

const initialsOf = (name) => String(name || "VU").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "VU";

function renderClassroom() {
  const sessions = mySessions();
  const live = sessions.find((session) => session.status === "Live");
  const joined = liveRoom.sessionId ? sessions.find((session) => session.id === liveRoom.sessionId && session.status === "Live") : null;

  if (joined) return renderJoinedRoom(joined, courseById(joined.courseId), false, []);

  const upcoming = sessions.filter((session) => session.status === "Scheduled").sort((a, b) => new Date(a.startsAt) - new Date(b.startsAt));
  const courses = myCourses();
  const canHost = currentRole() !== "student";

  const stage = live
    ? `<div class="empty-state"><span class="live-pill on"><span class="live-dot"></span> Live now</span><h2>${escapeHtml(live.title)}</h2><p>${escapeHtml(courseById(live.courseId)?.title || "Course")} | started ${formatDateTime(live.startsAt)}</p><div style="margin-top:14px; display:flex; gap:10px; justify-content:center; flex-wrap:wrap;"><button class="action primary" type="button" data-live-join="${escapeHtml(live.id)}">${icon("video")} ${canHost ? "Enter class" : "Join Class"}</button>${canHost ? `<button class="action danger" type="button" data-live-end="${escapeHtml(live.id)}">${icon("leave")} End Class</button>` : ""}</div>${currentRole() === "student" ? `<p class="mini-note" style="margin-top:12px;">Joining marks your attendance as present automatically.</p>` : ""}</div>`
    : canHost
      ? `<form class="form-grid" id="startClassForm"><div class="section-head"><h2>Start a live class</h2></div><label>Course<select name="courseId" required>${courses.map((course) => `<option value="${escapeHtml(course.id)}">${escapeHtml(course.code)} | ${escapeHtml(course.title)}</option>`).join("")}</select></label><label>Session title<input name="title" placeholder="Example: Week 4 REST APIs Lab"></label><label>Duration (minutes)<input name="duration" type="number" min="10" max="480" value="60"></label><button class="action primary" type="submit">${icon("video")} Start class now</button><p class="mini-note">Students in this course's field will see the class instantly and can join. Students who never join are marked absent when you end the class.</p></form>`
      : emptyState("No live class right now", "When your lecturer starts a class for your courses, a Join button appears here and your attendance is marked when you join.");

  return `<div class="live-shell">
    <section class="panel">${stage}</section>
    <aside class="panel"><div class="section-head"><h2>Available courses</h2></div><div class="deadline-list">${courses.map((course) => {
      const next = upcoming.find((session) => session.courseId === course.id);
      return `<article class="deadline-item"><span class="icon-dot">${icon("book")}</span><div><strong>${escapeHtml(course.title)}</strong><p>${next ? `Next class ${formatDateTime(next.startsAt)}` : escapeHtml(course.schedule || "Schedule to be announced")}</p></div></article>`;
    }).join("") || emptyState("No courses")}</div></aside>
  </div>`;
}

/* ============================== attendance ============================== */

function renderAttendance() {
  const isStudent = currentRole() === "student";
  const records = (isStudent ? state.attendance.filter((item) => item.userId === currentUser.id) : state.attendance)
    .filter((item) => matchesQuery(`${item.status} ${courseById(item.courseId)?.title || ""} ${userById(item.userId)?.name || ""}`))
    .slice()
    .sort((a, b) => new Date(b.joinedAt || 0) - new Date(a.joinedAt || 0));
  const present = records.filter((item) => item.status === "Present").length;
  const absent = records.filter((item) => item.status === "Absent").length;
  const rate = present + absent ? Math.round((present / (present + absent)) * 100) : 100;

  const graded = state.submissions.filter((item) => (isStudent ? item.userId === currentUser.id : true) && item.grade != null);

  const table = records.length ? `<div class="table-scroll"><table class="data-table"><thead><tr>${isStudent ? "" : "<th>Student</th>"}<th>Course</th><th>Session</th><th>Date</th><th>Status</th></tr></thead><tbody>${records.map((item) => {
    const session = state.classSessions.find((entry) => entry.id === item.sessionId);
    return `<tr>${isStudent ? "" : `<td>${escapeHtml(userById(item.userId)?.name || "Student")}</td>`}<td>${escapeHtml(courseById(item.courseId)?.title || "Course")}</td><td>${escapeHtml(session?.title || "Session")}</td><td>${item.joinedAt ? formatDateTime(item.joinedAt) : formatDateTime(session?.endedAt || session?.startsAt)}</td><td><span class="status-pill ${item.status === "Present" ? "ok" : "bad"}">${escapeHtml(item.status)}</span></td></tr>`;
  }).join("")}</tbody></table></div>` : emptyState("No attendance records yet", "Attendance is captured automatically when live classes run.");

  return `<section class="mini-metrics">${metricCard("Present", present, "Classes joined", "check")}${metricCard("Absent", absent, "Classes missed", "clock")}${metricCard("Attendance rate", `${rate}%`, "Auto-tracked from live classes", "chart")}${isStudent ? metricCard("Registered", formatDay(currentUser.createdAt), currentUser.studentNumber || currentUser.program || "VFU student", "users") : metricCard("Records", records.length, "All students", "users")}</section>
  <section class="panel"><div class="section-head"><h2>Attendance records</h2><span class="status-pill">Marked automatically</span></div>${table}</section>
  <section class="panel"><div class="section-head"><h2>Courses and scores</h2></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Course</th><th>Progress</th>${isStudent ? "<th>Latest score</th>" : "<th>Graded submissions</th>"}</tr></thead><tbody>${myCourses().map((course) => {
    const courseGrades = graded.filter((item) => item.courseId === course.id);
    const latest = courseGrades[courseGrades.length - 1];
    const assignment = latest ? state.assignments.find((entry) => entry.id === latest.assignmentId) : null;
    return `<tr><td>${escapeHtml(course.code)} | ${escapeHtml(course.title)}</td><td>${course.progress || 0}%</td><td>${isStudent ? (latest ? `${latest.grade}/${assignment?.points || "?"} pts` : "Not graded yet") : `${courseGrades.length}`}</td></tr>`;
  }).join("")}</tbody></table></div></section>`;
}

/* ============================== assignments ============================== */

function renderAssignments() {
  const courses = myCourses();
  const courseIds = new Set(courses.map((course) => course.id));
  const isStudent = currentRole() === "student";
  const assignments = state.assignments.filter((item) => courseIds.has(item.courseId) && matchesQuery(`${item.title} ${courseById(item.courseId)?.title || ""}`));

  const creator = !isStudent ? `<section class="panel"><div class="section-head"><h2>Create assignment</h2><span class="status-pill">Lecturers only</span></div><form class="form-grid" id="assignmentForm"><div class="form-grid cols-2"><label>Course<select name="courseId" required>${courses.map((course) => `<option value="${escapeHtml(course.id)}">${escapeHtml(course.code)} | ${escapeHtml(course.title)}</option>`).join("")}</select></label><label>Points<input name="points" type="number" min="1" max="100" value="20"></label></div><label>Title<input name="title" required placeholder="Assignment title"></label><label>Instructions<textarea name="description" placeholder="What should students do?" style="min-height:70px;"></textarea></label><label>Due date<input name="dueAt" type="datetime-local"></label><button class="action primary" type="submit">${icon("plus")} Publish assignment</button></form></section>` : "";

  const rows = assignments.length ? assignments.map((assignment) => {
    const course = courseById(assignment.courseId);
    const mySubmission = state.submissions.find((item) => item.assignmentId === assignment.id && item.userId === currentUser.id);
    const allSubmissions = state.submissions.filter((item) => item.assignmentId === assignment.id);
    const open = openAssignments.has(assignment.id);
    const detail = open ? `<div class="assignment-detail">
      ${assignment.description ? `<p>${escapeHtml(assignment.description)}</p>` : ""}
      <p class="eyebrow">Due ${formatDateTime(assignment.dueAt)} | ${assignment.points} points</p>
      ${isStudent ? `
        ${mySubmission ? `<div class="mini-note">Submitted ${formatDateTime(mySubmission.submittedAt)}${mySubmission.fileName ? ` | File: ${escapeHtml(mySubmission.fileName)}` : ""}${mySubmission.grade != null ? ` | Grade: ${mySubmission.grade}/${assignment.points}` : " | Not graded yet"}</div>` : ""}
        <form class="submit-form" data-submit-assignment="${escapeHtml(assignment.id)}">
          <textarea name="text" placeholder="Add notes about your submission (optional if you attach a file)">${escapeHtml(mySubmission?.text || "")}</textarea>
          <div class="file-row">${icon("upload")}<input type="file" name="file" data-file-for="${escapeHtml(assignment.id)}"><span id="fileStatus-${escapeHtml(assignment.id)}">${pendingFiles[assignment.id] ? escapeHtml(pendingFiles[assignment.id].name) : "Attach your work (max 700 KB)"}</span></div>
          <button class="action primary" type="submit">${icon("upload")} Submit</button>
        </form>`
      : `<div class="mini-note">${allSubmissions.length} submission${allSubmissions.length === 1 ? "" : "s"} received.</div>
        ${allSubmissions.length ? `<div class="table-scroll"><table class="data-table"><thead><tr><th>Student</th><th>Submitted</th><th>File</th><th>Grade</th></tr></thead><tbody>${allSubmissions.map((item) => `<tr><td>${escapeHtml(userById(item.userId)?.name || "Student")}</td><td>${formatDateTime(item.submittedAt)}</td><td>${escapeHtml(item.fileName || "None")}</td><td>${item.grade != null ? `${item.grade}/${assignment.points}` : "Pending"}</td></tr>`).join("")}</tbody></table></div>` : ""}`}
    </div>` : "";
    return `<article class="assignment-row"><button class="assignment-head" type="button" data-open-assignment="${escapeHtml(assignment.id)}"><div><h3>${escapeHtml(assignment.title)}</h3><p>${escapeHtml(course?.title || "Course")} | Due ${formatDateTime(assignment.dueAt)} | ${assignment.points} pts</p></div><span class="status-pill ${isStudent && mySubmission ? "ok" : ""}">${isStudent ? (mySubmission ? "Submitted" : "Open") : `${allSubmissions.length} submitted`}</span></button>${detail}</article>`;
  }).join("") : emptyState("No assignments yet", isStudent ? "Your lecturers publish assignments here." : "Publish your first assignment above.");

  return `${creator}<section class="panel"><div class="section-head"><h2>Assignments</h2><span class="status-pill">${assignments.length} listed</span></div><div class="assignment-list">${rows}</div></section>`;
}

/* ============================== group study (discussions) ============================== */

function renderDiscussions() {
  const courses = myCourses();
  const courseIds = new Set(courses.map((course) => course.id));

  if (studyState.roomId) {
    const room = state.studyRooms.find((item) => item.id === studyState.roomId && item.status === "Open");
    if (room) {
      const members = room.members.map((id) => userById(id)).filter(Boolean);
      return renderJoinedRoom(room, courseById(room.courseId), true, members);
    }
    studyState.roomId = null;
  }

  const rooms = state.studyRooms.filter((room) => room.status === "Open" && courseIds.has(room.courseId) && matchesQuery(`${room.topic} ${courseById(room.courseId)?.title || ""}`));
  const threads = state.discussions.filter((item) => courseIds.has(item.courseId) && matchesQuery(item.title));

  return `<section class="panel"><div class="section-head"><h2>Group Study Rooms</h2><span class="status-pill">${rooms.length} open</span></div>
    <form class="form-grid cols-2" id="studyForm" style="margin-bottom:14px;"><label>Course<select name="courseId" required>${courses.map((course) => `<option value="${escapeHtml(course.id)}">${escapeHtml(course.code)} | ${escapeHtml(course.title)}</option>`).join("")}</select></label><label>Study topic<input name="topic" required placeholder="Example: Revision for week 4 quiz"></label><button class="action primary" type="submit" style="grid-column: 1 / -1;">${icon("plus")} Open a study room</button></form>
    <div class="room-grid">${rooms.length ? rooms.map((room) => `<article class="room-card"><span class="live-pill on"><span class="live-dot"></span> In session</span><h3>${escapeHtml(room.topic)}</h3><p>${escapeHtml(courseById(room.courseId)?.title || "Course")}</p><p>Host: ${escapeHtml(room.hostName)} | ${room.members.length} member${room.members.length === 1 ? "" : "s"}</p><button class="action primary" type="button" data-study-join="${escapeHtml(room.id)}">${icon("video")} Join room</button></article>`).join("") : `<div class="mini-note" style="grid-column: 1 / -1;">No study rooms are open for your courses. Start one and invite your classmates. Rooms are private to students in the same course field.</div>`}</div>
  </section>
  <section class="panel"><div class="section-head"><h2>Course discussions</h2><span class="status-pill">${threads.length} threads</span></div><div class="assignment-list">${threads.length ? threads.map((discussion) => `<article class="discussion"><h3>${escapeHtml(discussion.title)}</h3><p>${escapeHtml(courseById(discussion.courseId)?.title || "Course")} | ${discussion.replies.length} replies</p>${discussion.replies.slice(-2).map((reply) => `<div class="reply"><strong>${escapeHtml(reply.author)}</strong><p>${escapeHtml(reply.text)}</p></div>`).join("")}<div style="margin-top:10px;"><button class="action" type="button" data-view-discussion="${escapeHtml(discussion.id)}">${icon("messages")} Reply</button></div></article>`).join("") : emptyState("No discussions yet")}</div></section>`;
}

/* ============================== analytics ============================== */

function renderAnalytics() {
  const isStudent = currentRole() === "student";
  const engagement = state.analytics.weeklyEngagement || [];
  const chart = `<section class="panel"><div class="section-head"><h2>Weekly engagement</h2></div><div class="chart">${engagement.map((value) => `<div class="bar" style="height:${Math.max(6, value)}%" title="${value}%"></div>`).join("")}</div></section>`;

  if (!isStudent) {
    return `<section class="metrics-grid grid">${metricCard("Active students", state.analytics.activeStudents, "Across all courses", "users")}${metricCard("Attendance", `${state.analytics.attendanceRate}%`, "Current term", "check")}${metricCard("Submissions", `${state.analytics.submissionRate}%`, "Assignment completion", "upload")}${metricCard("Average grade", `${state.analytics.averageGrade}%`, "Marked work", "chart")}</section>${chart}
    <section class="panel"><div class="section-head"><h2>Course completion</h2></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Course</th><th>Enrolled</th><th>Completion</th></tr></thead><tbody>${state.courses.map((course) => `<tr><td>${escapeHtml(course.code)} | ${escapeHtml(course.title)}</td><td>${course.enrolled || 0}</td><td>${course.progress || 0}%</td></tr>`).join("")}</tbody></table></div></section>`;
  }

  const stats = myAttendanceStats();
  const mySubs = state.submissions.filter((item) => item.userId === currentUser.id);
  const courses = myCourses();
  const completion = courses.length ? Math.round(courses.reduce((acc, course) => acc + (course.progress || 0), 0) / courses.length) : 0;
  const balance = Number(currentUser.pendingBalance || 0);
  const usage = JSON.parse(localStorage.getItem(usageKey) || "{}");
  const gpa = myGpa();

  return `<section class="metrics-grid grid">${metricCard("Pending balance", `K ${balance.toLocaleString("en")}`, "Tuition and fees", "wallet")}${metricCard("Attendance", `${stats.present} present / ${stats.absent} absent`, `${stats.rate}% rate`, "check")}${metricCard("Completion", `${completion}%`, "Average across your courses", "book")}${metricCard("Submissions", mySubs.length, gpa != null ? `GPA ${gpa.toFixed(1)} of 4.0` : "No graded work yet", "upload")}</section>
  ${chart}
  <section class="panel"><div class="section-head"><h2>App usage</h2></div><div class="mini-metrics">${metricCard("Sessions on this device", usage.visits || 1, "Since you started using the app", "clock")}${metricCard("Last active", usage.lastVisit ? formatDateTime(usage.lastVisit) : "Now", "This device", "users")}</div></section>
  <section class="panel"><div class="section-head"><h2>My courses overview</h2></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Course</th><th>Progress</th><th>Submissions</th></tr></thead><tbody>${courses.map((course) => `<tr><td>${escapeHtml(course.code)} | ${escapeHtml(course.title)}</td><td>${course.progress || 0}%</td><td>${mySubs.filter((item) => item.courseId === course.id).length}</td></tr>`).join("")}</tbody></table></div></section>`;
}

/* ============================== admin ============================== */

function renderAdmin() {
  if (currentRole() === "student") return emptyState("Admins only", "This area is for lecturers and administrators.");
  return `<section class="mini-metrics">${metricCard("Users", state.users.length, "Registered accounts", "users")}${metricCard("Courses", state.courses.length, "Across departments", "book")}${metricCard("Live now", state.classSessions.filter((session) => session.status === "Live").length, "Running classes", "video")}</section>
  <section class="panel"><div class="section-head"><h2>Create course</h2></div><form class="form-grid cols-2" id="courseForm"><label>Course code<input name="code" placeholder="ICT 351" required></label><label>Course title<input name="title" placeholder="Web Application Development" required></label><label>Department<select name="department"><option value="ICT">ICT</option><option value="Business and Financial Management">Business and Financial Management</option></select></label><label>Schedule<input name="schedule" placeholder="Mon and Wed, 09:00"></label><button class="action primary" type="submit" style="grid-column: 1 / -1;">${icon("plus")} Save course</button></form></section>
  <section class="panel"><div class="section-head"><h2>Users</h2></div><div class="table-scroll"><table class="data-table"><thead><tr><th>Name</th><th>Role</th><th>Program</th><th>Registered</th></tr></thead><tbody>${state.users.map((user) => `<tr><td>${escapeHtml(user.name)}</td><td>${escapeHtml(roleLabels[user.role] || user.role)}</td><td>${escapeHtml(user.program || "VFU")}</td><td>${formatDay(user.createdAt)}</td></tr>`).join("")}</tbody></table></div></section>`;
}

/* ============================== shell + render ============================== */

function renderShell() {
  document.body.classList.toggle("auth-mode", !currentUser);
  termLabel.textContent = state?.institution?.term || "VFU";
  navList.innerHTML = visibleRoutes().map((route) => `<button class="nav-item ${route.id === currentRoute ? "active" : ""}" type="button" data-route="${route.id}">${icon(route.icon)}<span>${route.label}</span></button>`).join("");
  if (sessionPanel) {
    sessionPanel.innerHTML = !currentUser
      ? `<p class="session-hint">Sign in or create a student account.</p>`
      : `<div class="session-card-mini"><span class="avatar">${escapeHtml(currentUser.avatar)}</span><div><strong>${escapeHtml(currentUser.name)}</strong><small>${escapeHtml(roleLabels[currentUser.role] || currentUser.role)} | ${escapeHtml(currentUser.program || "VFU")}</small></div></div><button class="session-logout" type="button" data-logout>${icon("logout")} Log Out</button>`;
  }
  if (profileCard) {
    profileCard.innerHTML = currentUser ? `<span class="avatar">${escapeHtml(currentUser.avatar)}</span><span><strong>${escapeHtml(currentUser.name)}</strong><small>${escapeHtml(currentUser.role)}</small></span>` : "";
  }
  const unread = state?.notifications?.filter((item) => !item.read).length || 0;
  notificationCount.textContent = unread;
  notificationCount.hidden = unread === 0;
}

function render() {
  if (!state) return;
  renderShell();
  if (!currentUser) {
    viewRoot.innerHTML = renderAuth();
    return;
  }
  const viewMap = {
    dashboard: renderDashboard, courses: renderCourses, classroom: renderClassroom,
    attendance: renderAttendance, assignments: renderAssignments, discussions: renderDiscussions,
    analytics: renderAnalytics, admin: renderAdmin
  };
  viewRoot.innerHTML = (viewMap[currentRoute] || viewMap.dashboard)();
  afterRender();
}

function setRoute(route) {
  currentRoute = route;
  pageTitle.textContent = routes.find((item) => item.id === route)?.label || "Dashboard";
  render();
}

async function loadState() {
  state = await api("/api/state");
  const session = readSession();
  if (session?.user?.id) currentUser = state.users.find((user) => user.id === session.user.id) || session.user;
  render();
}

function bumpUsage() {
  try {
    const usage = JSON.parse(localStorage.getItem(usageKey) || "{}");
    usage.visits = (usage.visits || 0) + 1;
    usage.lastVisit = new Date().toISOString();
    localStorage.setItem(usageKey, JSON.stringify(usage));
  } catch { /* usage tracking is best-effort */ }
}

/* ============================== actions ============================== */

async function handleAuthSubmit(event) {
  event.preventDefault();
  const payload = Object.fromEntries(new FormData(event.target).entries());
  try {
    const response = await api(authMode === "login" ? "/api/login" : "/api/signup", { method: "POST", body: payload });
    currentUser = response.user;
    saveSession({ user: response.user, token: response.token });
    authMode = "login";
    authRole = currentUser.role;
    bumpUsage();
    await loadState();
    showToast(`Welcome, ${currentUser.name.split(" ")[0]}. You are signed in.`);
  } catch (error) {
    showToast(error.message || "Authentication failed. Please check your details.", "error");
  }
}

async function joinLiveSession(sessionId) {
  try {
    await api("/api/sessions/join", { method: "POST", body: { sessionId, userId: currentUser.id } });
    liveRoom.sessionId = sessionId;
    liveRoom.messages = [];
    liveRoom.hand = false;
    await startLocalMedia();
    await loadState();
    showToast(currentRole() === "student" ? "You joined the class. Attendance marked present." : "You are in the live class.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function endLiveSession(sessionId) {
  try {
    await api("/api/sessions/end", { method: "POST", body: { sessionId, userId: currentUser.id } });
    stopMedia();
    liveRoom.sessionId = null;
    await loadState();
    showToast("Class ended. Students who never joined were marked absent.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function leaveLiveSession() {
  stopMedia();
  liveRoom.sessionId = null;
  liveRoom.hand = false;
  render();
  showToast("You left the class.");
}

async function handleLiveAction(action) {
  if (action === "mic") { liveRoom.mic = !liveRoom.mic; applyTrackStates(); }
  else if (action === "camera") { liveRoom.camera = !liveRoom.camera; applyTrackStates(); }
  else if (action === "screen") { await toggleScreenShare(); return; }
  else if (action === "hand") {
    liveRoom.hand = !liveRoom.hand;
    if (liveRoom.hand) liveRoom.messages.push({ author: "Class", text: `${currentUser.name} raised a hand.` });
  }
  render();
}

async function handleSubmitAssignment(form) {
  const assignmentId = form.dataset.submitAssignment;
  const text = String(new FormData(form).get("text") || "").trim();
  const file = pendingFiles[assignmentId];
  if (!text && !file) { showToast("Add notes or attach a file before submitting.", "warning"); return; }
  try {
    await api("/api/submissions", { method: "POST", body: { assignmentId, userId: currentUser.id, text, fileName: file?.name || "", fileType: file?.type || "", fileSize: file?.size || 0, fileData: file?.data || "" } });
    delete pendingFiles[assignmentId];
    await loadState();
    showToast("Assignment submitted.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function handleFileSelected(input) {
  const assignmentId = input.dataset.fileFor;
  const file = input.files?.[0];
  const status = document.getElementById(`fileStatus-${assignmentId}`);
  if (!file) { delete pendingFiles[assignmentId]; if (status) status.textContent = "Attach your work (max 700 KB)"; return; }
  if (file.size > 700 * 1024) {
    input.value = "";
    delete pendingFiles[assignmentId];
    if (status) status.textContent = "File is too large. Keep it under 700 KB.";
    showToast("File is too large. Keep it under 700 KB.", "warning");
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    pendingFiles[assignmentId] = { name: file.name, type: file.type, size: file.size, data: String(reader.result || "") };
    if (status) status.textContent = `${file.name} (${(file.size / 1024).toFixed(1)} KB) ready`;
  };
  reader.readAsDataURL(file);
}

async function handleDiscussionReply(discussionId) {
  const text = window.prompt("Write a reply to the discussion:", "");
  if (text === null || !text.trim()) return;
  try {
    await api("/api/discussions/reply", { method: "POST", body: { discussionId, userId: currentUser.id, text } });
    await loadState();
    showToast("Reply posted.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

async function joinStudy(roomId) {
  try {
    await api("/api/studyrooms/join", { method: "POST", body: { roomId, userId: currentUser.id } });
    studyState.roomId = roomId;
    studyState.messages = [];
    await startLocalMedia();
    await loadState();
    showToast("You joined the study room.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

function leaveStudy() {
  stopMedia();
  studyState.roomId = null;
  render();
  showToast("You left the study room.");
}

async function closeStudy(roomId) {
  try {
    await api("/api/studyrooms/close", { method: "POST", body: { roomId, userId: currentUser.id } });
    stopMedia();
    studyState.roomId = null;
    await loadState();
    showToast("Study room closed.");
  } catch (error) {
    showToast(error.message, "error");
  }
}

/* ============================== event wiring ============================== */

function handleViewInteraction(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const data = button.dataset;

  if (data.route) return setRoute(data.route);
  if (data.routeJump) return setRoute(data.routeJump);
  if (data.themeSet) return applyTheme(data.themeSet);

  if (data.logout !== undefined && "logout" in data) {
    api("/api/logout", { method: "POST" }).catch(() => {});
    stopMedia();
    liveRoom.sessionId = null; studyState.roomId = null;
    clearSession();
    currentUser = null;
    render();
    return;
  }

  if (data.authMode) { authMode = data.authMode; render(); return; }
  if (data.liveJoin) return void joinLiveSession(data.liveJoin);
  if (data.liveEnd) return void endLiveSession(data.liveEnd);
  if ("liveLeave" in data) return leaveLiveSession();
  if (data.liveAction) return void handleLiveAction(data.liveAction);
  if (data.livePanel) { liveRoom.panel = data.livePanel; render(); return; }
  if (data.studyJoin) return void joinStudy(data.studyJoin);
  if ("studyLeave" in data) return leaveStudy();
  if (data.studyClose) return void closeStudy(data.studyClose);
  if (data.viewDiscussion) return void handleDiscussionReply(data.viewDiscussion);

  if (data.openAssignment) {
    if (openAssignments.has(data.openAssignment)) openAssignments.delete(data.openAssignment);
    else openAssignments.add(data.openAssignment);
    render();
  }
}

function registerAppEvents() {
  document.addEventListener("click", handleViewInteraction);

  document.addEventListener("submit", async (event) => {
    const form = event.target;

    if (form.id === "authForm") return void handleAuthSubmit(event);

    if (form.id === "courseForm") {
      event.preventDefault();
      try {
        await api("/api/courses", { method: "POST", body: { ...Object.fromEntries(new FormData(form).entries()), lecturerId: currentRole() === "lecturer" ? currentUser.id : undefined } });
        await loadState();
        showToast("Course created.");
      } catch (error) { showToast(error.message, "error"); }
      return;
    }

    if (form.id === "assignmentForm") {
      event.preventDefault();
      try {
        await api("/api/assignments", { method: "POST", body: Object.fromEntries(new FormData(form).entries()) });
        await loadState();
        showToast("Assignment published.");
      } catch (error) { showToast(error.message, "error"); }
      return;
    }

    if (form.id === "startClassForm") {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await api("/api/sessions/start", { method: "POST", body: { ...payload, userId: currentUser.id } });
        liveRoom.sessionId = response.session.id;
        liveRoom.messages = [];
        await startLocalMedia();
        await loadState();
        showToast("Live class started. Students can now join.");
      } catch (error) { showToast(error.message, "error"); }
      return;
    }

    if (form.id === "studyForm") {
      event.preventDefault();
      const payload = Object.fromEntries(new FormData(form).entries());
      try {
        const response = await api("/api/studyrooms", { method: "POST", body: { ...payload, userId: currentUser.id } });
        studyState.roomId = response.room.id;
        studyState.messages = [];
        await startLocalMedia();
        await loadState();
        showToast("Study room is open. Classmates in your field can join.");
      } catch (error) { showToast(error.message, "error"); }
      return;
    }

    if (form.dataset.submitAssignment) {
      event.preventDefault();
      await handleSubmitAssignment(form);
      return;
    }

    if (form.id === "chatForm") {
      event.preventDefault();
      const text = String(new FormData(form).get("message") || "").trim();
      if (!text) return;
      const bucket = currentRoute === "discussions" ? studyState.messages : liveRoom.messages;
      bucket.push({ author: currentUser?.name || "Guest", text });
      form.reset();
      render();
    }
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "searchInput") { query = event.target.value; if (currentUser) render(); }
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("input[type='file'][data-file-for]")) handleFileSelected(event.target);
  });

  notificationButton?.addEventListener("click", () => {
    const unread = state?.notifications?.filter((item) => !item.read) || [];
    showToast(unread.length ? `${unread.length} new: ${unread.map((item) => item.title).join(" | ")}` : "You are all caught up.");
  });

  window.addEventListener("beforeunload", stopMedia);
}

/* ============================== init ============================== */

applyTheme(localStorage.getItem(themeKey) || "dark", false);
registerAppEvents();
if (readSession()) bumpUsage();
loadState().catch(() => {
  viewRoot.innerHTML = emptyState("Could not load the classroom", "Refresh the page to try again.");
});

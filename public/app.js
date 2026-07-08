
(() => {
  if (window.location.protocol !== "file:") return;
  const originalFetch = window.fetch.bind(window);
  const storageKey = "vfu-offline-state";
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const readState = () => JSON.parse(localStorage.getItem(storageKey) || JSON.stringify(clone(window.VFU_SEED_STATE)));
  const saveState = (data) => localStorage.setItem(storageKey, JSON.stringify(data));
  const initials = (name) => String(name || "VFU").split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0].toUpperCase()).join("") || "VU";
  const jsonResponse = (payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json; charset=utf-8" } });

  window.fetch = async (resource, options = {}) => {
    const path = String(resource);
    if (!path.startsWith("/api/")) return originalFetch(resource, options);
    const method = options.method || "GET";
    const body = options.body ? JSON.parse(options.body) : {};
    const data = readState();

    if (method === "GET" && path === "/api/state") return jsonResponse(data);
    if (method === "POST" && path === "/api/login") {
      const role = String(body.role || "student").toLowerCase();
      const email = String(body.email || "").toLowerCase();
      const user = data.users.find((item) => item.role === role && item.email.toLowerCase() === email) || data.users.find((item) => item.role === role) || data.users[0];
      return jsonResponse({ user, token: `offline-${Date.now()}` });
    }
    if (method === "POST" && path === "/api/signup") {
      const email = String(body.email || "").trim().toLowerCase();
      if (!email || data.users.some((user) => user.email.toLowerCase() === email)) return jsonResponse({ error: "Use a new valid email address." }, 400);
      const user = { id: `u-${body.role || "student"}-${Date.now()}`, name: String(body.name || "New User").trim(), email, role: body.role === "lecturer" ? "lecturer" : "student", program: String(body.program || body.department || "VFU").trim(), studentNumber: body.studentNumber || "", staffNumber: body.staffNumber || "", phone: body.phone || "", avatar: initials(body.name), createdAt: new Date().toISOString() };
      data.users.push(user); saveState(data); return jsonResponse({ user, token: `offline-${Date.now()}` }, 201);
    }
    if (method === "POST" && path === "/api/attendance") {
      const session = data.classSessions.find((item) => item.id === body.sessionId);
      const exists = data.attendance.some((item) => item.sessionId === body.sessionId && item.userId === body.userId);
      if (session && !exists) { data.attendance.push({ id: `att-${Date.now()}`, sessionId: session.id, courseId: session.courseId, userId: body.userId, status: "Present", joinedAt: new Date().toISOString() }); saveState(data); }
      return jsonResponse({ attendance: data.attendance, message: "Attendance recorded." });
    }
    if (method === "POST" && path === "/api/submissions") {
      const assignment = data.assignments.find((item) => item.id === body.assignmentId);
      const existing = data.submissions.find((item) => item.assignmentId === body.assignmentId && item.userId === body.userId);
      if (assignment && existing) { existing.text = String(body.text || ""); existing.status = "Updated"; existing.submittedAt = new Date().toISOString(); }
      else if (assignment) data.submissions.push({ id: `sub-${Date.now()}`, assignmentId: assignment.id, courseId: assignment.courseId, userId: body.userId, text: String(body.text || ""), status: "Submitted", grade: null, submittedAt: new Date().toISOString() });
      saveState(data); return jsonResponse({ submissions: data.submissions, message: "Assignment submitted." });
    }
    if (method === "POST" && path === "/api/discussions/reply") {
      const discussion = data.discussions.find((item) => item.id === body.discussionId);
      const user = data.users.find((item) => item.id === body.userId);
      if (discussion && user) { discussion.replies.push({ id: `reply-${Date.now()}`, userId: user.id, author: user.name, text: String(body.text || "").trim(), createdAt: new Date().toISOString() }); saveState(data); }
      return jsonResponse({ discussions: data.discussions, message: "Reply posted." });
    }
    if (method === "POST" && path === "/api/courses") {
      data.courses.push({ id: `course-${Date.now()}`, code: String(body.code || "").toUpperCase(), title: String(body.title || ""), lecturerId: body.lecturerId || "u-lecturer-1", department: body.department || "ICT", progress: 0, color: "#2563eb", schedule: body.schedule || "Not scheduled", room: "Virtual", enrolled: 0 });
      saveState(data); return jsonResponse({ courses: data.courses });
    }
    return jsonResponse({ error: "Offline API route was not found." }, 404);
  };
})();

const routes = [
  { id: "dashboard", label: "Dashboard", icon: "layout" }, { id: "courses", label: "Courses", icon: "book" },
  { id: "classroom", label: "Live Room", icon: "video" }, { id: "attendance", label: "Attendance", icon: "check" },
  { id: "assignments", label: "Assignments", icon: "file" }, { id: "discussions", label: "Discussions", icon: "messages" },
  { id: "analytics", label: "Analytics", icon: "chart" }, { id: "admin", label: "Admin", icon: "settings" }
];
const roleLabels = { student: "Student", lecturer: "Lecturer", admin: "Admin" };
const demoPasswords = { student: "student123", lecturer: "lecturer123", admin: "admin123" };
const sessionKey = "vfu-session";
let state = null, currentRoute = "dashboard", currentUser = null, query = "", authMode = "login", authRole = "student", whiteboardReady = false, selectedDocUrl = "";
let uploadedDocs = [];
const liveRoom = { joined: false, mic: true, camera: true, screen: false, raisedHand: false, activePanel: "chat", whiteboardTool: "pen", whiteboardColor: "#2563eb", quizOpen: false, quizQuestion: "Which HTTP method is best for creating a new course record?", quizOptions: ["GET", "POST", "DELETE"], quizVotes: {}, messages: [{ author: "Dr. Naomi Banda", text: "Welcome. Keep microphones muted unless speaking." }, { author: "Alex Likando", text: "Present and following the REST API lecture." }] };

function roleGreeting() {
  if (currentRole() === "lecturer") return "Manage classes, launch live teaching tools, and monitor student progress.";
  if (currentRole() === "admin") return "Control academic operations, course setup, enrolment visibility, and performance signals.";
  return "Join live classes, submit work, track attendance, and collaborate with lecturers.";
}

function renderDashboard() {
  const liveSession = state.classSessions.find((session) => session.status === "Live");
  const course = liveSession ? courseById(liveSession.courseId) : state.courses[0];
  return `<section class="hero-band dashboard-hero"><div class="classroom-visual"><div class="classroom-copy"><span class="live-pill">${liveRoom.joined ? "In live room" : "Ready to join"}</span><h2>${escapeHtml(course?.title || "No course")}</h2><p>${escapeHtml(roleGreeting())}</p><div class="action-row hero-actions"><button class="action primary" type="button" data-route-jump="classroom">${icon("video")} Open live room</button><button class="action glass" type="button" data-route-jump="courses">${icon("book")} Browse courses</button></div></div></div><div class="panel today-panel"><div class="section-head"><h2>Today</h2><span class="status-pill">${escapeHtml(currentRole())}</span></div><div class="today-list"><article><strong>${escapeHtml(liveSession?.title || "No live class")}</strong><p>${liveSession ? `${formatDate(liveSession.startsAt)} - ${liveSession.duration} min - ${liveSession.participants} online` : "Check upcoming course sessions."}</p></article><article><strong>${currentRole() === "student" ? "Next assignment" : "Teaching actions"}</strong><p>${currentRole() === "student" ? "Secure course API is due soon." : "Invite learners, publish quiz, share documents."}</p></article></div></div></section>
  <section class="grid metrics-grid">${metricCard("Active students", state.analytics.activeStudents, "Across all courses", "users")}${metricCard("Attendance", `${state.analytics.attendanceRate}%`, "Current term", "check")}${metricCard("Submissions", `${state.analytics.submissionRate}%`, "Assignment completion", "upload")}${metricCard("Average grade", `${state.analytics.averageGrade}%`, "Marked work", "chart")}</section>
  <section class="panel"><div class="section-head"><h2>Interactive Course Progress</h2><button class="action" type="button" data-route-jump="analytics">${icon("chart")} View analytics</button></div><div class="grid course-grid">${renderCourseCards(state.courses.slice(0, 3))}</div></section>`;
}

function renderCourseCards(courses) {
  if (!courses.length) return emptyState();
  return courses.map((course) => `<article class="course-card" style="--course-color: ${course.color};"><div><p class="eyebrow">${escapeHtml(course.code)} - ${escapeHtml(course.department)}</p><h3>${escapeHtml(course.title)}</h3></div><div class="meta-row"><span>${escapeHtml(course.schedule)}</span><span>${course.enrolled} enrolled</span></div><div class="progress" aria-label="${course.progress}% complete"><span style="--value: ${course.progress}%"></span></div><div class="row-between"><span class="status-pill">${course.progress}% complete</span><button class="action" type="button" data-route-jump="classroom">${icon("video")} Join</button></div></article>`).join("");
}

function renderCourses() {
  const courses = state.courses.filter((course) => matchesQuery(`${course.code} ${course.title} ${course.department}`));
  return `<section class="panel"><div class="section-head"><h2>Courses</h2>${currentRole() !== "student" ? `<button class="action primary" type="button" data-route-jump="admin">${icon("plus")} Add course</button>` : ""}</div><div class="grid course-grid">${renderCourseCards(courses)}</div></section>`;
}

function renderAttendance() {
  const attendanceRows = state.attendance.filter((item) => matchesQuery(`${item.status} ${courseById(item.courseId)?.title || ""}`));
  return `<section class="panel"><div class="section-head"><h2>Attendance</h2><span class="status-pill">${attendanceRows.length} marked</span></div><div class="assignment-list">${attendanceRows.length ? attendanceRows.map((item) => { const session = state.classSessions.find((entry) => entry.id === item.sessionId); const course = courseById(item.courseId); return `<article class="assignment-row"><div><h3>${escapeHtml(course?.title || "Course")}</h3><p>${escapeHtml(session?.title || "Session")}</p></div><span class="status-pill">${escapeHtml(item.status)}</span></article>`; }).join("") : emptyState("No attendance records yet")}</div></section>`;
}

function renderAssignments() {
  const assignments = state.assignments.filter((item) => matchesQuery(`${item.title} ${courseById(item.courseId)?.title || ""}`));
  const submissionsByAssignment = new Map(state.submissions.map((item) => [item.assignmentId, item]));
  return `<section class="panel"><div class="section-head"><h2>Assignments</h2><span class="status-pill">${assignments.length} listed</span></div><div class="assignment-list">${assignments.length ? assignments.map((assignment) => { const submission = submissionsByAssignment.get(assignment.id); const course = courseById(assignment.courseId); return `<article class="assignment-row"><div><h3>${escapeHtml(assignment.title)}</h3><p>${escapeHtml(course?.title || "Course")} • Due ${formatDate(assignment.dueAt)} • ${assignment.points} pts</p></div><div class="row-between"><span class="status-pill">${escapeHtml(assignment.status)}</span>${currentRole() === "student" ? `<button class="action primary" type="button" data-submit-assignment="${assignment.id}">${icon("upload")} ${submission ? "Update" : "Submit"}</button>` : ""}</div></article>`; }).join("") : emptyState("No assignments available")}</div></section>`;
}

function renderDiscussions() {
  const discussions = state.discussions.filter((item) => matchesQuery(`${item.title} ${courseById(item.courseId)?.title || ""}`));
  return `<section class="panel"><div class="section-head"><h2>Discussions</h2><span class="status-pill">${discussions.length} threads</span></div><div class="assignment-list">${discussions.length ? discussions.map((discussion) => `<article class="assignment-row"><div><h3>${escapeHtml(discussion.title)}</h3><p>${discussion.replies.length} replies</p></div><button class="action" type="button" data-view-discussion="${discussion.id}">${icon("messages")} Open</button></article>`).join("") : emptyState("No discussions yet")}</div></section>`;
}

function renderAnalytics() {
  return `<section class="grid metrics-grid">${metricCard("Engagement", `${state.analytics.weeklyEngagement.reduce((acc, value) => acc + value, 0) / state.analytics.weeklyEngagement.length || 0}%`, "Weekly trend", "chart")}${metricCard("Attendance", `${state.analytics.attendanceRate}%`, "Current rate", "check")}${metricCard("Completion", `${state.analytics.courseCompletion.reduce((acc, value) => acc + value, 0) / state.analytics.courseCompletion.length || 0}%`, "Course progress", "book")}${metricCard("Submissions", `${state.analytics.submissionRate}%`, "Assignment completion", "upload")}</section><section class="panel"><div class="section-head"><h2>Academic overview</h2><span class="status-pill">${currentRole()}</span></div><div class="assignment-list"><article class="assignment-row"><div><h3>Live classroom activity</h3><p>Attendance and participation are being tracked live for each course.</p></div><span class="status-pill">Live</span></article></div></section>`;
}

function renderAdmin() {
  const canManage = currentRole() !== "student";
  return `<section class="panel"><div class="section-head"><h2>Administration</h2>${canManage ? `<button class="action primary" type="button" data-create-course>${icon("plus")} Create course</button>` : ""}</div>${canManage ? `<form class="auth-form" id="courseForm"><label>Course code<input name="code" placeholder="ICT 351" required></label><label>Course title<input name="title" placeholder="Web Application Development" required></label><label>Department<input name="department" placeholder="ICT"></label><label>Schedule<input name="schedule" placeholder="Mon and Wed, 09:00"></label><button class="action primary wide" type="submit">${icon("plus")} Save course</button></form>` : emptyState("Only lecturers and admins can manage courses")}</section>`;
}

function renderPanelTabs() {
  return [["chat", "Chat", "messages"], ["people", "People", "users"], ["invite", "Invite", "invite"], ["quiz", "Quiz", "quiz"], ["whiteboard", "Whiteboard", "board"], ["presentation", "Presentation", "upload"]].map(([id, label, iconName]) => `<button class="panel-tab ${liveRoom.activePanel === id ? "active" : ""}" type="button" data-live-panel="${id}">${icon(iconName)} ${label}</button>`).join("");
}
function renderChatPanel() {
  return `<div class="live-side-body"><div class="chat-stream">${liveRoom.messages.map((message) => `<article class="chat-message"><strong>${escapeHtml(message.author)}</strong><p>${escapeHtml(message.text)}</p></article>`).join("")}</div><form class="compose inline" id="chatForm"><input name="message" placeholder="Message the room" autocomplete="off"><button class="action primary" type="submit" title="Send message">${icon("send")}</button></form></div>`;
}
function renderPeoplePanel() {
  return `<div class="live-side-body participant-list">${state.users.slice(0, 8).map((user) => `<article><span class="avatar">${escapeHtml(user.avatar)}</span><div><strong>${escapeHtml(user.name)}</strong><p>${escapeHtml(user.role)} - ${escapeHtml(user.program)}</p></div><span class="presence"></span></article>`).join("")}</div>`;
}
function renderInvitePanel() {
  const link = `${window.location.origin}${window.location.pathname}#classroom`;
  return `<div class="live-side-body invite-panel"><label>Room invite link<input id="inviteLink" readonly value="${escapeHtml(link)}"></label><div class="action-row"><button class="action primary" type="button" data-copy-invite>${icon("invite")} Copy invite</button><button class="action" type="button" data-toast="Invite email prepared for enrolled learners.">${icon("send")} Email class</button></div><div class="mini-note">Invites are scoped to this virtual room and can be connected to SMS/email services later.</div></div>`;
}
function renderQuizPanel() {
  const total = Object.values(liveRoom.quizVotes).length || 1;
  return `<div class="live-side-body quiz-panel">${currentRole() !== "student" ? `<form id="quizForm" class="quiz-builder"><label>Question<input name="question" value="${escapeHtml(liveRoom.quizQuestion)}"></label><label>Options<input name="options" value="${escapeHtml(liveRoom.quizOptions.join(", "))}"></label><button class="action primary" type="submit">${icon("quiz")} Publish quiz</button></form>` : ""}<article class="quiz-card"><span class="live-pill">${liveRoom.quizOpen ? "Open quiz" : "Quiz ready"}</span><h3>${escapeHtml(liveRoom.quizQuestion)}</h3><div class="quiz-options">${liveRoom.quizOptions.map((option) => { const count = Object.values(liveRoom.quizVotes).filter((vote) => vote === option).length; const width = Math.round((count / total) * 100); return `<button type="button" data-quiz-vote="${escapeHtml(option)}"><span>${escapeHtml(option)}</span><small>${count} vote${count === 1 ? "" : "s"}</small><i style="width:${width}%"></i></button>`; }).join("")}</div></article></div>`;
}
function renderWhiteboardPanel() {
  return `<div class="live-side-body whiteboard-panel"><div class="whiteboard-toolbar"><button class="tool-button ${liveRoom.whiteboardTool === "pen" ? "active" : ""}" type="button" data-board-tool="pen">${icon("pen")} Pen</button><button class="tool-button ${liveRoom.whiteboardTool === "eraser" ? "active" : ""}" type="button" data-board-tool="eraser">${icon("eraser")} Eraser</button><input type="color" id="boardColor" value="${liveRoom.whiteboardColor}" title="Whiteboard color"><button class="tool-button" type="button" data-board-clear>${icon("leave")} Clear</button></div><canvas id="whiteboard" width="900" height="520" aria-label="Collaborative whiteboard"></canvas></div>`;
}
function renderPresentationPanel() {
  const doc = uploadedDocs[0]; const isPdf = doc?.type === "application/pdf" || doc?.name.toLowerCase().endsWith(".pdf"); const isImage = doc?.type?.startsWith("image/");
  return `<div class="live-side-body presentation-panel"><label class="upload-zone">${icon("upload")}<span>Upload PDF, Word, PowerPoint, Excel, text, or image files</span><input id="presentationUpload" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.rtf,.csv,.png,.jpg,.jpeg,.webp,application/pdf,image/*"></label>${doc ? `<article class="document-preview"><div><strong>${escapeHtml(doc.name)}</strong><p>${escapeHtml(doc.type || "Document")} - ${(doc.size / 1024).toFixed(1)} KB</p></div><span class="status-pill">Selected</span></article>` : `<div class="mini-note">No presentation selected yet.</div>`}${doc && isPdf ? `<iframe class="doc-frame" src="${selectedDocUrl}" title="PDF presentation preview"></iframe>` : doc && isImage ? `<img class="doc-image" src="${selectedDocUrl}" alt="Uploaded presentation preview">` : doc ? `<div class="doc-fallback">${icon("file")} Browser preview is available for PDFs and images. Other document formats are queued for conversion in production storage.</div>` : ""}</div>`;
}
function renderActiveLivePanel() {
  if (liveRoom.activePanel === "people") return renderPeoplePanel();
  if (liveRoom.activePanel === "invite") return renderInvitePanel();
  if (liveRoom.activePanel === "quiz") return renderQuizPanel();
  if (liveRoom.activePanel === "whiteboard") return renderWhiteboardPanel();
  if (liveRoom.activePanel === "presentation") return renderPresentationPanel();
  return renderChatPanel();
}
function renderClassroom() {
  const sessions = state.classSessions.filter((session) => matchesQuery(`${session.title} ${courseById(session.courseId)?.title}`));
  const liveSession = sessions.find((session) => session.status === "Live") || sessions[0]; const course = liveSession ? courseById(liveSession.courseId) : state.courses[0];
  return `<section class="live-room-layout"><div class="session-panel live-stage"><div class="section-head"><div><p class="eyebrow">${escapeHtml(course?.code || "VFU")} - ${escapeHtml(course?.title || "Virtual Classroom")}</p><h2>${escapeHtml(liveSession?.title || "Virtual Classroom")}</h2></div><span class="live-pill ${liveRoom.joined ? "on" : ""}">${liveRoom.joined ? "Connected" : "Not joined"}</span></div><div class="video-board zoom-board"><div class="video-tile primary-tile"><span>${icon(liveRoom.screen ? "screen" : "video")}<strong>${liveRoom.screen ? "Screen share active" : "Lecturer stream"}</strong><small>${liveRoom.camera ? "Camera ready" : "Camera paused"} - ${liveRoom.mic ? "Mic open" : "Mic muted"}</small></span></div><div class="video-tile"><span><strong>Student Group A</strong><small>18 online</small></span></div><div class="video-tile"><span><strong>Student Group B</strong><small>16 online</small></span></div><div class="video-tile"><span><strong>Shared Tools</strong><small>${escapeHtml(liveRoom.activePanel)}</small></span></div></div><div class="live-toolbar" aria-label="Live classroom controls">${liveToolButton(liveRoom.joined ? "leave" : "join", liveRoom.joined ? "Leave" : "Join", liveRoom.joined ? "leave" : "video", liveRoom.joined, liveRoom.joined)}${liveToolButton("mic", liveRoom.mic ? "Mute" : "Unmute", liveRoom.mic ? "mic" : "micOff", liveRoom.mic)}${liveToolButton("camera", liveRoom.camera ? "Camera" : "Camera off", "video", liveRoom.camera)}${liveToolButton("screen", liveRoom.screen ? "Stop share" : "Share", "screen", liveRoom.screen)}${liveToolButton("hand", liveRoom.raisedHand ? "Lower hand" : "Raise hand", "hand", liveRoom.raisedHand)}${liveToolButton("attendance", "Attendance", "check")}${liveToolButton("invite", "Invite", "invite")}</div></div><aside class="live-side panel"><div class="live-tabs">${renderPanelTabs()}</div>${renderActiveLivePanel()}</aside></section><section class="panel"><div class="section-head"><h2>Sessions</h2><span class="status-pill">${sessions.length} listed</span></div><div class="assignment-list">${sessions.length ? sessions.map((session) => { const itemCourse = courseById(session.courseId); return `<article class="assignment-row"><div><h3>${escapeHtml(session.title)}</h3><p>${escapeHtml(itemCourse?.code || "VFU")} - ${formatDate(session.startsAt)} - ${session.duration} min</p></div><span class="status-pill">${escapeHtml(session.status)}</span></article>`; }).join("") : emptyState()}</div></section>`;
}

const viewRoot = document.querySelector("#viewRoot"), navList = document.querySelector("#navList"), sessionPanel = document.querySelector("#sessionPanel"), profileCard = document.querySelector("#profileCard"), pageTitle = document.querySelector("#pageTitle"), termLabel = document.querySelector("#termLabel"), notificationCount = document.querySelector("#notificationCount"), notificationButton = document.querySelector("#notificationButton"), searchInput = document.querySelector("#searchInput"), noticeStack = document.querySelector("#noticeStack"), roleSwitch = document.querySelector("#roleSwitch");
const iconPaths = {
  layout: "<rect x='3' y='3' width='7' height='7'></rect><rect x='14' y='3' width='7' height='7'></rect><rect x='14' y='14' width='7' height='7'></rect><rect x='3' y='14' width='7' height='7'></rect>", book: "<path d='M4 19.5A2.5 2.5 0 0 1 6.5 17H20'></path><path d='M4 4.5A2.5 2.5 0 0 1 6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5z'></path>", video: "<path d='M23 7l-7 5 7 5V7z'></path><rect x='1' y='5' width='15' height='14' rx='2'></rect>", check: "<path d='M20 6L9 17l-5-5'></path>", file: "<path d='M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z'></path><path d='M14 2v6h6'></path><path d='M8 13h8'></path><path d='M8 17h6'></path>", messages: "<path d='M21 15a4 4 0 0 1-4 4H7l-4 4V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4z'></path>", chart: "<path d='M3 3v18h18'></path><rect x='7' y='12' width='3' height='5'></rect><rect x='12' y='8' width='3' height='9'></rect><rect x='17' y='5' width='3' height='12'></rect>", settings: "<circle cx='12' cy='12' r='3'></circle><path d='M19 15a2 2 0 0 0 .4 2l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a2 2 0 0 0-2-.4 2 2 0 0 0-1.2 1.8V21a2 2 0 1 1-4 0v-.2a2 2 0 0 0-1.2-1.8 2 2 0 0 0-2 .4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a2 2 0 0 0 .4-2 2 2 0 0 0-1.8-1.2H3a2 2 0 1 1 0-4h.2A2 2 0 0 0 5 8.2a2 2 0 0 0-.4-2l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a2 2 0 0 0 2 .4A2 2 0 0 0 10.6 2H11a2 2 0 1 1 4 0v.2a2 2 0 0 0 1.2 1.8 2 2 0 0 0 2-.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a2 2 0 0 0-.4 2 2 2 0 0 0 1.8 1.2H21a2 2 0 1 1 0 4h-.2A2 2 0 0 0 19 15z'></path>", bell: "<path d='M18 8a6 6 0 1 0-12 0c0 7-3 7-3 7h18s-3 0-3-7'></path><path d='M13.73 21a2 2 0 0 1-3.46 0'></path>", plus: "<path d='M12 5v14'></path><path d='M5 12h14'></path>", send: "<path d='M22 2L11 13'></path><path d='M22 2l-7 20-4-9-9-4 20-7z'></path>", upload: "<path d='M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4'></path><path d='M17 8l-5-5-5 5'></path><path d='M12 3v12'></path>", mic: "<path d='M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z'></path><path d='M19 10v2a7 7 0 0 1-14 0v-2'></path><path d='M12 19v4'></path><path d='M8 23h8'></path>", micOff: "<path d='M1 1l22 22'></path><path d='M9 9v3a3 3 0 0 0 5 2'></path><path d='M15 9V4a3 3 0 0 0-6 0v1'></path><path d='M19 10v2a7 7 0 0 1-.5 2.6'></path><path d='M12 19v4'></path>", screen: "<rect x='2' y='3' width='20' height='14' rx='2'></rect><path d='M8 21h8'></path><path d='M12 17v4'></path>", leave: "<path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'></path><path d='M16 17l5-5-5-5'></path><path d='M21 12H9'></path>", invite: "<path d='M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'></path><circle cx='8.5' cy='7' r='4'></circle><path d='M20 8v6'></path><path d='M23 11h-6'></path>", hand: "<path d='M18 11V6a2 2 0 0 0-4 0v5'></path><path d='M14 10V4a2 2 0 0 0-4 0v8'></path><path d='M10 10.5V5a2 2 0 0 0-4 0v9'></path><path d='M6 13l-1.6-1.6a2 2 0 0 0-2.8 2.8l5.2 5.2A8 8 0 0 0 20 14v-3a2 2 0 1 0-4 0'></path>", board: "<path d='M4 3h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z'></path><path d='M8 21h8'></path><path d='M12 17v4'></path>", quiz: "<circle cx='12' cy='12' r='10'></circle><path d='M9 9a3 3 0 0 1 6 1c0 2-3 3-3 3'></path><path d='M12 17h.01'></path>", pen: "<path d='M12 20h9'></path><path d='M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z'></path>", eraser: "<path d='M7 21h10'></path><path d='M22 12.5 13.5 4a2.1 2.1 0 0 0-3 0L2 12.5a2.1 2.1 0 0 0 0 3L7.5 21h5L22 15.5a2.1 2.1 0 0 0 0-3Z'></path>", users: "<path d='M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'></path><circle cx='9' cy='7' r='4'></circle><path d='M23 21v-2a4 4 0 0 0-3-3.87'></path><path d='M16 3.13a4 4 0 0 1 0 7.75'></path>", logout: "<path d='M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'></path><path d='M16 17l5-5-5-5'></path><path d='M21 12H9'></path>"
};
const icon = (name) => `<svg aria-hidden="true" viewBox="0 0 24 24">${iconPaths[name] || iconPaths.layout}</svg>`;
const escapeHtml = (value) => String(value ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
const formatDate = (value) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const courseById = (id) => state.courses.find((course) => course.id === id) || state.courses[0];
const currentRole = () => currentUser?.role || authRole;
const visibleRoutes = () => !currentUser ? [] : currentRole() === "student" ? routes.filter((route) => route.id !== "admin") : routes;
const matchesQuery = (text) => String(text).toLowerCase().includes(query.trim().toLowerCase());
const readSession = () => { try { return JSON.parse(localStorage.getItem(sessionKey) || "null"); } catch { return null; } };
const saveSession = (session) => localStorage.setItem(sessionKey, JSON.stringify(session));
const clearSession = () => localStorage.removeItem(sessionKey);
async function api(path, options = {}) {
  const session = readSession();
  const headers = { "content-type": "application/json", ...(options.headers || {}) };
  if (session?.token) headers.authorization = `Bearer ${session.token}`;
  const response = await fetch(path, { ...options, headers, body: options.body ? JSON.stringify(options.body) : undefined });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || "Request failed");
  return payload;
}

async function loadState() {
  state = await api("/api/state");
  const session = readSession();
  if (session?.user?.id) currentUser = state.users.find((user) => user.id === session.user.id) || session.user;
  renderShell(); render();
}

function renderShell() {
  document.body.classList.toggle("auth-mode", !currentUser);

  termLabel.textContent = state?.institution?.term || "VFU";
  navList.innerHTML = visibleRoutes().map((route) => `<button class="nav-item ${route.id === currentRoute ? "active" : ""}" type="button" data-route="${route.id}">${icon(route.icon)}<span>${route.label}</span></button>`).join("");
  if (sessionPanel) {
    if (!currentUser) {
      sessionPanel.innerHTML = `<p class="session-hint">Sign in or create a learner/lecturer account.</p>`;
    } else {
      sessionPanel.innerHTML = `<div class="session-card-mini"><span class="avatar">${escapeHtml(currentUser.avatar)}</span><div><strong>${escapeHtml(roleLabels[currentUser.role] || currentUser.role)}</strong><small>${escapeHtml(currentUser.program || "VFU")}</small></div></div><button class="session-logout" type="button" data-logout>${icon("logout")} Sign out</button>`;
    }
  }
  if (profileCard) {
    profileCard.innerHTML = currentUser ? `<span class="avatar">${escapeHtml(currentUser.avatar)}</span><span><strong>${escapeHtml(currentUser.name)}</strong><small>${escapeHtml(currentUser.role)}</small></span>` : "";
  }
  const unread = state?.notifications?.filter((item) => !item.read).length || 0;
  notificationCount.textContent = unread; notificationCount.hidden = unread === 0;
}

function setRoute(route) {
  currentRoute = route; pageTitle.textContent = routes.find((item) => item.id === route)?.label || "Dashboard"; renderShell(); render();
}

function showToast(message, tone = "success") {
  const toast = document.createElement("div"); toast.className = `toast ${tone}`; toast.textContent = message; noticeStack.append(toast); setTimeout(() => toast.remove(), 3400);
}

function emptyState(message = "No matching records") {
  return `<div class="empty-state"><div class="empty-visual" aria-hidden="true"></div><h2>${escapeHtml(message)}</h2><p>Try a different search term or choose another module.</p></div>`;
}

function metricCard(label, value, detail, iconName = "chart") {
  return `<article class="metric"><span class="metric-icon">${icon(iconName)}</span><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong><p class="eyebrow">${escapeHtml(detail)}</p></article>`;
}

function renderAuth() {
  pageTitle.textContent = "Welcome";
  const isLogin = authMode === "login";
  const role = isLogin ? authRole : authMode === "signup-lecturer" ? "lecturer" : "student";
  return `<section class="auth-layout">
    <div class="auth-visual"><span class="brand-mark large">V</span><p class="eyebrow">${escapeHtml(state.institution.term)}</p><h1>${escapeHtml(state.institution.name)}</h1><p>${escapeHtml(state.institution.tagline)}</p><div class="auth-feature-grid"><span>${icon("video")} Live classes</span><span>${icon("board")} Whiteboard</span><span>${icon("quiz")} Quizzes</span><span>${icon("chart")} Analytics</span></div></div>
    <div class="auth-panel"><div class="auth-tabs" role="tablist" aria-label="Authentication options"><button class="${authMode === "login" ? "active" : ""}" type="button" data-auth-mode="login">Login</button><button class="${authMode === "signup-student" ? "active" : ""}" type="button" data-auth-mode="signup-student">Student sign up</button><button class="${authMode === "signup-lecturer" ? "active" : ""}" type="button" data-auth-mode="signup-lecturer">Lecturer sign up</button></div>
    <form class="auth-form" id="authForm" data-mode="${authMode}"><div><p class="eyebrow">${isLogin ? "Secure access" : role === "student" ? "Learner registration" : "Lecturer registration"}</p><h2>${isLogin ? "Sign in to your classroom" : role === "student" ? "Create student account" : "Create lecturer account"}</h2></div>
      ${isLogin ? `<label>Role<select name="role" id="loginRole"><option value="student" ${authRole === "student" ? "selected" : ""}>Student</option><option value="lecturer" ${authRole === "lecturer" ? "selected" : ""}>Lecturer</option><option value="admin" ${authRole === "admin" ? "selected" : ""}>Admin</option></select></label>` : `<input type="hidden" name="role" value="${role}">`}
      ${!isLogin ? `<label>Full name<input name="name" required placeholder="Enter full name"></label>` : ""}
      <label>Email<input name="email" type="email" required value="${isLogin ? `${authRole}@vfu.local` : ""}" placeholder="name@vfu.edu"></label><label>Password<input name="password" type="password" required minlength="6" value="${isLogin ? escapeHtml(demoPasswords[authRole] || "") : ""}" placeholder="Minimum 6 characters"></label>
      ${!isLogin && role === "student" ? `<div class="field-grid"><label>Student number<input name="studentNumber" required placeholder="VFU-ST-2026-001"></label><label>Program<select name="program"><option>BSc Information and Communication Technology</option><option>BSc Business and Financial Management</option><option>Diploma in ICT</option></select></label></div><label>Phone<input name="phone" placeholder="Optional"></label>` : ""}
      ${!isLogin && role === "lecturer" ? `<div class="field-grid"><label>Staff number<input name="staffNumber" required placeholder="VFU-LEC-2026-001"></label><label>School<select name="department"><option>School of ICT</option><option>Business and Financial Management</option><option>Academic Registry</option></select></label></div><label>Primary course<input name="program" placeholder="Example: Web Application Development"></label>` : ""}
      <button class="action primary wide" type="submit">${icon(isLogin ? "logout" : "plus")} ${isLogin ? "Login" : "Create account"}</button><p class="auth-note">Demo accounts: student@vfu.local / student123, lecturer@vfu.local / lecturer123, admin@vfu.local / admin123.</p>
    </form></div></section>`;
}

function roleGreeting() {
  if (currentRole() === "lecturer") return "Manage classes, launch live teaching tools, and monitor student progress.";
  if (currentRole() === "admin") return "Control academic operations, course setup, enrolment visibility, and performance signals.";
  return "Join live classes, submit work, track attendance, and collaborate with lecturers.";
}

function renderDashboard() {
  const liveSession = state.classSessions.find((session) => session.status === "Live");
  const course = liveSession ? courseById(liveSession.courseId) : state.courses[0];
  return `<section class="hero-band dashboard-hero"><div class="classroom-visual"><div class="classroom-copy"><span class="live-pill">${liveRoom.joined ? "In live room" : "Ready to join"}</span><h2>${escapeHtml(course.title)}</h2><p>${escapeHtml(roleGreeting())}</p><div class="action-row hero-actions"><button class="action primary" type="button" data-route-jump="classroom">${icon("video")} Open live room</button><button class="action glass" type="button" data-route-jump="courses">${icon("book")} Browse courses</button></div></div></div><div class="panel today-panel"><div class="section-head"><h2>Today</h2><span class="status-pill">${escapeHtml(currentRole())}</span></div><div class="today-list"><article><strong>${escapeHtml(liveSession?.title || "No live class")}</strong><p>${liveSession ? `${formatDate(liveSession.startsAt)} - ${liveSession.duration} min - ${liveSession.participants} online` : "Check upcoming course sessions."}</p></article><article><strong>${currentRole() === "student" ? "Next assignment" : "Teaching actions"}</strong><p>${currentRole() === "student" ? "Secure course API is due soon." : "Invite learners, publish quiz, share documents."}</p></article></div></div></section>
  <section class="grid metrics-grid">${metricCard("Active students", state.analytics.activeStudents, "Across all courses", "users")}${metricCard("Attendance", `${state.analytics.attendanceRate}%`, "Current term", "check")}${metricCard("Submissions", `${state.analytics.submissionRate}%`, "Assignment completion", "upload")}${metricCard("Average grade", `${state.analytics.averageGrade}%`, "Marked work", "chart")}</section>
  <section class="panel"><div class="section-head"><h2>Interactive Course Progress</h2><button class="action" type="button" data-route-jump="analytics">${icon("chart")} View analytics</button></div><div class="grid course-grid">${renderCourseCards(state.courses.slice(0, 3))}</div></section>`;
}
function renderCourseCards(courses) {
  if (!courses.length) return emptyState();
  return courses.map((course) => `<article class="course-card" style="--course-color: ${course.color};"><div><p class="eyebrow">${escapeHtml(course.code)} - ${escapeHtml(course.department)}</p><h3>${escapeHtml(course.title)}</h3></div><div class="meta-row"><span>${escapeHtml(course.schedule)}</span><span>${course.enrolled} enrolled</span></div><div class="progress" aria-label="${course.progress}% complete"><span style="--value: ${course.progress}%"></span></div><div class="row-between"><span class="status-pill">${course.progress}% complete</span><button class="action" type="button" data-route-jump="classroom">${icon("video")} Join</button></div></article>`).join("");
}
function renderCourses() {
  const courses = state.courses.filter((course) => matchesQuery(`${course.code} ${course.title} ${course.department}`));
  return `<section class="panel"><div class="section-head"><h2>Courses</h2>${currentRole() !== "student" ? `<button class="action primary" type="button" data-route-jump="admin">${icon("plus")} Add course</button>` : ""}</div><div class="grid course-grid">${renderCourseCards(courses)}</div></section>`;
}
const liveToolButton = (key, label, iconName, active = false, danger = false) => `<button class="tool-button ${active ? "active" : ""} ${danger ? "danger" : ""}" type="button" data-live-action="${key}" title="${escapeHtml(label)}">${icon(iconName)}<span>${escapeHtml(label)}</span></button>`;
function renderPanelTabs() {
  return [["chat", "Chat", "messages"], ["people", "People", "users"], ["invite", "Invite", "invite"], ["quiz", "Quiz", "quiz"], ["whiteboard", "Whiteboard", "board"], ["presentation", "Presentation", "upload"]].map(([id, label, iconName]) => `<button class="panel-tab ${liveRoom.activePanel === id ? "active" : ""}" type="button" data-live-panel="${id}">${icon(iconName)} ${label}</button>`).join("");
}
function renderChatPanel() {
  return `<div class="live-side-body"><div class="chat-stream">${liveRoom.messages.map((message) => `<article class="chat-message"><strong>${escapeHtml(message.author)}</strong><p>${escapeHtml(message.text)}</p></article>`).join("")}</div><form class="compose inline" id="chatForm"><input name="message" placeholder="Message the room" autocomplete="off"><button class="action primary" type="submit" title="Send message">${icon("send")}</button></form></div>`;
}
function renderPeoplePanel() {
  return `<div class="live-side-body participant-list">${state.users.slice(0, 8).map((user) => `<article><span class="avatar">${escapeHtml(user.avatar)}</span><div><strong>${escapeHtml(user.name)}</strong><p>${escapeHtml(user.role)} - ${escapeHtml(user.program)}</p></div><span class="presence"></span></article>`).join("")}</div>`;
}
function renderInvitePanel() {
  const link = `${window.location.origin}${window.location.pathname}#classroom`;
  return `<div class="live-side-body invite-panel"><label>Room invite link<input id="inviteLink" readonly value="${escapeHtml(link)}"></label><div class="action-row"><button class="action primary" type="button" data-copy-invite>${icon("invite")} Copy invite</button><button class="action" type="button" data-toast="Invite email prepared for enrolled learners.">${icon("send")} Email class</button></div><div class="mini-note">Invites are scoped to this virtual room and can be connected to SMS/email services later.</div></div>`;
}
function renderQuizPanel() {
  const total = Object.values(liveRoom.quizVotes).length || 1;
  return `<div class="live-side-body quiz-panel">${currentRole() !== "student" ? `<form id="quizForm" class="quiz-builder"><label>Question<input name="question" value="${escapeHtml(liveRoom.quizQuestion)}"></label><label>Options<input name="options" value="${escapeHtml(liveRoom.quizOptions.join(", "))}"></label><button class="action primary" type="submit">${icon("quiz")} Publish quiz</button></form>` : ""}<article class="quiz-card"><span class="live-pill">${liveRoom.quizOpen ? "Open quiz" : "Quiz ready"}</span><h3>${escapeHtml(liveRoom.quizQuestion)}</h3><div class="quiz-options">${liveRoom.quizOptions.map((option) => { const count = Object.values(liveRoom.quizVotes).filter((vote) => vote === option).length; const width = Math.round((count / total) * 100); return `<button type="button" data-quiz-vote="${escapeHtml(option)}"><span>${escapeHtml(option)}</span><small>${count} vote${count === 1 ? "" : "s"}</small><i style="width:${width}%"></i></button>`; }).join("")}</div></article></div>`;
}
function renderWhiteboardPanel() {
  return `<div class="live-side-body whiteboard-panel"><div class="whiteboard-toolbar"><button class="tool-button ${liveRoom.whiteboardTool === "pen" ? "active" : ""}" type="button" data-board-tool="pen">${icon("pen")} Pen</button><button class="tool-button ${liveRoom.whiteboardTool === "eraser" ? "active" : ""}" type="button" data-board-tool="eraser">${icon("eraser")} Eraser</button><input type="color" id="boardColor" value="${liveRoom.whiteboardColor}" title="Whiteboard color"><button class="tool-button" type="button" data-board-clear>${icon("leave")} Clear</button></div><canvas id="whiteboard" width="900" height="520" aria-label="Collaborative whiteboard"></canvas></div>`;
}
function renderPresentationPanel() {
  const doc = uploadedDocs[0]; const isPdf = doc?.type === "application/pdf" || doc?.name.toLowerCase().endsWith(".pdf"); const isImage = doc?.type?.startsWith("image/");
  return `<div class="live-side-body presentation-panel"><label class="upload-zone">${icon("upload")}<span>Upload PDF, Word, PowerPoint, Excel, text, or image files</span><input id="presentationUpload" type="file" accept=".pdf,.doc,.docx,.ppt,.pptx,.xls,.xlsx,.txt,.rtf,.csv,.png,.jpg,.jpeg,.webp,application/pdf,image/*"></label>${doc ? `<article class="document-preview"><div><strong>${escapeHtml(doc.name)}</strong><p>${escapeHtml(doc.type || "Document")} - ${(doc.size / 1024).toFixed(1)} KB</p></div><span class="status-pill">Selected</span></article>` : `<div class="mini-note">No presentation selected yet.</div>`}${doc && isPdf ? `<iframe class="doc-frame" src="${selectedDocUrl}" title="PDF presentation preview"></iframe>` : doc && isImage ? `<img class="doc-image" src="${selectedDocUrl}" alt="Uploaded presentation preview">` : doc ? `<div class="doc-fallback">${icon("file")} Browser preview is available for PDFs and images. Other document formats are queued for conversion in production storage.</div>` : ""}</div>`;
}
function renderActiveLivePanel() {
  if (liveRoom.activePanel === "people") return renderPeoplePanel();
  if (liveRoom.activePanel === "invite") return renderInvitePanel();
  if (liveRoom.activePanel === "quiz") return renderQuizPanel();
  if (liveRoom.activePanel === "whiteboard") return renderWhiteboardPanel();
  if (liveRoom.activePanel === "presentation") return renderPresentationPanel();
  return renderChatPanel();
}
function renderClassroom() {
  const sessions = state.classSessions.filter((session) => matchesQuery(`${session.title} ${courseById(session.courseId)?.title}`));
  const liveSession = sessions.find((session) => session.status === "Live") || sessions[0]; const course = liveSession ? courseById(liveSession.courseId) : state.courses[0];
  return `<section class="live-room-layout"><div class="session-panel live-stage"><div class="section-head"><div><p class="eyebrow">${escapeHtml(course.code)} - ${escapeHtml(course.title)}</p><h2>${escapeHtml(liveSession?.title || "Virtual Classroom")}</h2></div><span class="live-pill ${liveRoom.joined ? "on" : ""}">${liveRoom.joined ? "Connected" : "Not joined"}</span></div><div class="video-board zoom-board"><div class="video-tile primary-tile"><span>${icon(liveRoom.screen ? "screen" : "video")}<strong>${liveRoom.screen ? "Screen share active" : "Lecturer stream"}</strong><small>${liveRoom.camera ? "Camera ready" : "Camera paused"} - ${liveRoom.mic ? "Mic open" : "Mic muted"}</small></span></div><div class="video-tile"><span><strong>Student Group A</strong><small>18 online</small></span></div><div class="video-tile"><span><strong>Student Group B</strong><small>16 online</small></span></div><div class="video-tile"><span><strong>Shared Tools</strong><small>${escapeHtml(liveRoom.activePanel)}</small></span></div></div><div class="live-toolbar" aria-label="Live classroom controls">${liveToolButton(liveRoom.joined ? "leave" : "join", liveRoom.joined ? "Leave" : "Join", liveRoom.joined ? "leave" : "video", liveRoom.joined, liveRoom.joined)}${liveToolButton("mic", liveRoom.mic ? "Mute" : "Unmute", liveRoom.mic ? "mic" : "micOff", liveRoom.mic)}${liveToolButton("camera", liveRoom.camera ? "Camera" : "Camera off", "video", liveRoom.camera)}${liveToolButton("screen", liveRoom.screen ? "Stop share" : "Share", "screen", liveRoom.screen)}${liveToolButton("hand", liveRoom.raisedHand ? "Lower hand" : "Raise hand", "hand", liveRoom.raisedHand)}${liveToolButton("attendance", "Attendance", "check")}${liveToolButton("invite", "Invite", "invite")}</div></div><aside class="live-side panel"><div class="live-tabs">${renderPanelTabs()}</div>${renderActiveLivePanel()}</aside></section><section class="panel"><div class="section-head"><h2>Sessions</h2><span class="status-pill">${sessions.length} listed</span></div><div class="assignment-list">${sessions.length ? sessions.map((session) => { const itemCourse = courseById(session.courseId); return `<article class="assignment-row"><div><h3>${escapeHtml(session.title)}</h3><p>${escapeHtml(itemCourse.code)} - ${formatDate(session.startsAt)} - ${session.duration} min</p></div><span class="status-pill">${escapeHtml(session.status)}</span></article>`; }).join("") : emptyState()}</div></section>`;
}

function render() {
  if (!state) return;
  renderShell();
  
  if (!currentUser) {
    viewRoot.innerHTML = renderAuth();
    return;
  }

  const viewMap = {
    dashboard: renderDashboard(),
    courses: renderCourses(),
    classroom: renderClassroom(),
    attendance: renderAttendance(),
    assignments: renderAssignments(),
    discussions: renderDiscussions(),
    analytics: renderAnalytics(),
    admin: renderAdmin()
  };

  viewRoot.innerHTML = viewMap[currentRoute] || viewMap.dashboard;
}

async function handleAuthSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form).entries());
  
  try {
    const response = await api(authMode === "login" ? "/api/login" : "/api/signup", {
      method: "POST",
      body: payload
    });
    currentUser = response.user;
    saveSession({ user: response.user, token: response.token });
    authMode = "login";
    authRole = currentUser.role;
    showToast("Welcome! You've been signed in.", "success");
    render();
  } catch (error) {
    showToast(error.message || "Authentication failed. Please check your details.", "error");
  }
}

async function handleCourseSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const payload = Object.fromEntries(new FormData(form).entries());
  await api("/api/courses", { method: "POST", body: payload });
  await loadState();
  showToast("Course created.");
}

async function handleAssignmentSubmit(assignmentId) {
  const text = window.prompt("Describe your submission or attach notes:", "");
  if (text === null) return;
  await api("/api/submissions", {
    method: "POST",
    body: { assignmentId, userId: currentUser.id, text }
  });
  await loadState();
  showToast("Assignment submission saved.");
}

async function handleDiscussionReply(discussionId) {
  const text = window.prompt("Write a reply to the discussion:", "");
  if (text === null) return;
  await api("/api/discussions/reply", {
    method: "POST",
    body: { discussionId, userId: currentUser.id, text }
  });
  await loadState();
  showToast("Reply posted.");
}

function handleLiveAction(action) {
  if (action === "join") {
    liveRoom.joined = true;
    showToast("Joined the live room.");
  } else if (action === "leave") {
    liveRoom.joined = false;
    showToast("Left the live room.");
  } else if (action === "mic") {
    liveRoom.mic = !liveRoom.mic;
    showToast(liveRoom.mic ? "Microphone enabled." : "Microphone muted.");
  } else if (action === "camera") {
    liveRoom.camera = !liveRoom.camera;
    showToast(liveRoom.camera ? "Camera enabled." : "Camera paused.");
  } else if (action === "screen") {
    liveRoom.screen = !liveRoom.screen;
    showToast(liveRoom.screen ? "Screen share enabled." : "Screen share stopped.");
  } else if (action === "hand") {
    liveRoom.raisedHand = !liveRoom.raisedHand;
    showToast(liveRoom.raisedHand ? "Hand raised." : "Hand lowered.");
  } else if (action === "attendance") {
    showToast("Attendance is being tracked for this session.");
  } else if (action === "invite") {
    showToast("Invite link ready for sharing.");
  }
  render();
}

function handleChatSubmit(event) {
  event.preventDefault();
  const form = event.target;
  const text = String(new FormData(form).get("message") || "").trim();
  if (!text) return;
  liveRoom.messages.push({ author: currentUser?.name || "Guest", text });
  form.reset();
  render();
}

function handleQuizVote(option) {
  liveRoom.quizVotes[currentUser?.id || "guest"] = option;
  liveRoom.quizOpen = true;
  render();
}

function handleViewInteraction(event) {
  const button = event.target.closest("button");
  if (!button) return;
  const route = button.dataset.route;
  if (route) {
    setRoute(route);
    return;
  }

  const routeJump = button.dataset.routeJump;
  if (routeJump) {
    setRoute(routeJump);
    return;
  }

  if (button.dataset.logout) {
    api("/api/logout", { method: "POST" }).catch(() => {});
    clearSession();
    currentUser = null;
    render();
    return;
  }

  if (button.dataset.authMode) {
    authMode = button.dataset.authMode;
    authRole = authMode === "signup-lecturer" ? "lecturer" : "student";
    render();
    return;
  }

  if (button.dataset.liveAction) {
    handleLiveAction(button.dataset.liveAction);
    return;
  }

  if (button.dataset.submitAssignment) {
    handleAssignmentSubmit(button.dataset.submitAssignment);
    return;
  }

  if (button.dataset.viewDiscussion) {
    handleDiscussionReply(button.dataset.viewDiscussion);
    return;
  }

  if (button.dataset.copyInvite) {
    const input = document.getElementById("inviteLink");
    if (input) {
      input.select();
      navigator.clipboard?.writeText(input.value).catch(() => {});
    }
    showToast("Invite link copied.");
    return;
  }

  if (button.dataset.toast) {
    showToast(button.dataset.toast);
    return;
  }

  if (button.dataset.demoRole) {
    authRole = button.dataset.demoRole;
    authMode = "login";
    render();
    return;
  }

  if (button.dataset.quizVote) {
    handleQuizVote(button.dataset.quizVote);
    return;
  }

  if (button.dataset.boardTool) {
    liveRoom.whiteboardTool = button.dataset.boardTool;
    render();
    return;
  }

  if (button.dataset.boardClear) {
    liveRoom.whiteboardColor = "#2563eb";
    render();
    return;
  }
}

function handleAppInput(event) {
  if (event.target.id === "searchInput") {
    query = event.target.value;
    render();
  }

  if (event.target.id === "boardColor") {
    liveRoom.whiteboardColor = event.target.value;
    render();
  }
}

function registerAppEvents() {
  document.addEventListener("click", handleViewInteraction);
  document.addEventListener("submit", async (event) => {
    if (event.target.id === "authForm") {
      await handleAuthSubmit(event);
      return;
    }

    if (event.target.id === "courseForm") {
      await handleCourseSubmit(event);
      return;
    }

    if (event.target.id === "chatForm") {
      handleChatSubmit(event);
    }

    if (event.target.id === "quizForm") {
      event.preventDefault();
      const form = event.target;
      const data = Object.fromEntries(new FormData(form).entries());
      liveRoom.quizQuestion = String(data.question || "").trim() || liveRoom.quizQuestion;
      liveRoom.quizOptions = String(data.options || "").split(",").map((item) => item.trim()).filter(Boolean);
      if (!liveRoom.quizOptions.length) liveRoom.quizOptions = ["Option A", "Option B"];
      liveRoom.quizOpen = true;
      showToast("Quiz published.");
      render();
    }
  });
  document.addEventListener("input", handleAppInput);
  notificationButton?.addEventListener("click", () => showToast("You have 2 new notifications."));
}

registerAppEvents();
loadState();

window.VFU_SEED_STATE = {
  "institution": {
    "name": "VFU E-Learning Classroom",
    "tagline": "Interactive learning, attendance, collaboration, and academic monitoring.",
    "term": "June 2026 Semester"
  },
  "programs": [
    { "id": "prog-ict", "name": "Information and Communication Technology", "code": "ICT" },
    { "id": "prog-biz", "name": "Business and Financial Management", "code": "BIZ" }
  ],
  "users": [
    {
      "id": "u-student-1",
      "name": "Alex Likando",
      "email": "student@vfu.local",
      "passwordHash": "sha256$9f2c4a71b3d05e68$5a53062d5bf09eddfd5f0de40ab7903fe0035396cb82b40138b82f93d29041d3",
      "role": "student",
      "program": "BSc Information and Communication Technology",
      "programId": "prog-ict",
      "studentNumber": "VFU-ST-2026-001",
      "avatar": "AL",
      "createdAt": "2026-01-12T08:00:00.000Z",
      "pendingBalance": 2500
    },
    {
      "id": "u-student-2",
      "name": "Bwalya Mwansa",
      "email": "bwalya@vfu.local",
      "passwordHash": "sha256$1d7be0934ac25f81$6cfd7e79ffb24a8e661c0489984c3d420a3c9f12a7353369318a417ca93d16e6",
      "role": "student",
      "program": "BSc Business and Financial Management",
      "programId": "prog-biz",
      "studentNumber": "VFU-ST-2026-002",
      "avatar": "BM",
      "createdAt": "2026-01-15T08:00:00.000Z",
      "pendingBalance": 1800
    },
    {
      "id": "u-lecturer-1",
      "name": "Dr. Naomi Banda",
      "email": "lecturer@vfu.local",
      "passwordHash": "sha256$c48a015de6b937f2$ae4bd9f36c1d04abd1b5d916f6f76b33bbd5b1a4e7d618ea25b16985b1eef575",
      "role": "lecturer",
      "program": "School of ICT",
      "programId": "prog-ict",
      "avatar": "NB",
      "createdAt": "2025-09-01T08:00:00.000Z"
    },
    {
      "id": "u-admin-1",
      "name": "System Administrator",
      "email": "admin@vfu.local",
      "passwordHash": "sha256$6b93f2c1a08d45e7$28282bec25a719459c70c2d3b3b4a9db4dd45e3c633a7eac737c513a17296588",
      "role": "admin",
      "program": "Academic Registry",
      "programId": null,
      "avatar": "SA",
      "createdAt": "2025-09-01T08:00:00.000Z"
    }
  ],
  "courses": [
    {
      "id": "course-web",
      "code": "ICT 351",
      "title": "Web Application Development",
      "lecturerId": "u-lecturer-1",
      "department": "ICT",
      "programId": "prog-ict",
      "parentCourseId": null,
      "progress": 72,
      "color": "#2563eb",
      "schedule": "Mon and Wed, 09:00",
      "nextUp": "Week 4 - REST APIs Lab",
      "room": "Virtual Room A",
      "enrolled": 42
    },
    {
      "id": "course-db",
      "code": "ICT 322",
      "title": "Database Systems",
      "lecturerId": "u-lecturer-1",
      "department": "ICT",
      "programId": "prog-ict",
      "parentCourseId": null,
      "progress": 58,
      "color": "#059669",
      "schedule": "Tue, 11:00",
      "nextUp": "Week 3 - Normalization",
      "room": "Virtual Room B",
      "enrolled": 38
    },
    {
      "id": "course-net",
      "code": "ICT 311",
      "title": "Computer Networks",
      "lecturerId": "u-lecturer-1",
      "department": "ICT",
      "programId": "prog-ict",
      "parentCourseId": null,
      "progress": 64,
      "color": "#d97706",
      "schedule": "Thu, 14:00",
      "nextUp": "Week 3 - Routing Practical",
      "room": "Virtual Lab",
      "enrolled": 45
    },
    {
      "id": "course-fin",
      "code": "BFM 210",
      "title": "Financial Accounting",
      "lecturerId": "u-lecturer-1",
      "department": "Business and Financial Management",
      "programId": "prog-biz",
      "parentCourseId": null,
      "progress": 47,
      "color": "#7c3aed",
      "schedule": "Fri, 10:00",
      "nextUp": "Week 3 - Ledgers and Trial Balance",
      "room": "Virtual Room C",
      "enrolled": 31
    }
  ],
  "classSessions": [
    {
      "id": "session-past",
      "courseId": "course-web",
      "title": "REST APIs and secure session design",
      "startsAt": "2026-06-21T17:30:00.000Z",
      "duration": 90,
      "status": "Ended",
      "endedAt": "2026-06-21T19:00:00.000Z",
      "participants": 34
    },
    {
      "id": "session-next",
      "courseId": "course-db",
      "title": "Normalization and relational integrity",
      "startsAt": "2026-07-15T08:00:00.000Z",
      "duration": 75,
      "status": "Scheduled",
      "participants": 0
    }
  ],
  "attendance": [
    {
      "id": "att-1",
      "sessionId": "session-past",
      "courseId": "course-web",
      "userId": "u-student-1",
      "status": "Present",
      "joinedAt": "2026-06-21T17:32:00.000Z"
    }
  ],
  "assignments": [
    {
      "id": "assignment-api",
      "courseId": "course-web",
      "title": "Build a secure course API",
      "description": "Design and implement a small REST API with login, role checks, and validation. Submit your source files and a short write-up.",
      "dueAt": "2026-07-20T23:59:00.000Z",
      "points": 20,
      "status": "Open"
    },
    {
      "id": "assignment-er",
      "courseId": "course-db",
      "title": "E-learning database ER diagram",
      "description": "Model the e-learning platform as an entity relationship diagram covering users, courses, sessions, and submissions.",
      "dueAt": "2026-07-22T23:59:00.000Z",
      "points": 15,
      "status": "Open"
    },
    {
      "id": "assignment-routing",
      "courseId": "course-net",
      "title": "Network routing practical",
      "description": "Complete the routing lab worksheet and attach your configuration files.",
      "dueAt": "2026-07-25T23:59:00.000Z",
      "points": 10,
      "status": "Open"
    }
  ],
  "submissions": [
    {
      "id": "sub-1",
      "assignmentId": "assignment-er",
      "courseId": "course-db",
      "userId": "u-student-1",
      "text": "Initial ER model submitted for review.",
      "fileName": "",
      "fileType": "",
      "fileSize": 0,
      "fileData": "",
      "status": "Submitted",
      "grade": 13,
      "submittedAt": "2026-06-18T15:20:00.000Z"
    }
  ],
  "discussions": [
    {
      "id": "disc-1",
      "courseId": "course-web",
      "title": "How should we protect classroom API routes?",
      "createdBy": "u-lecturer-1",
      "replies": [
        {
          "id": "reply-1",
          "userId": "u-lecturer-1",
          "author": "Dr. Naomi Banda",
          "text": "Start with authentication, role checks, validation, and audit logs.",
          "createdAt": "2026-06-20T09:10:00.000Z"
        },
        {
          "id": "reply-2",
          "userId": "u-student-1",
          "author": "Alex Likando",
          "text": "I will add route-level checks for student, lecturer, and admin access.",
          "createdAt": "2026-06-20T11:42:00.000Z"
        }
      ]
    }
  ],
  "studyRooms": [],
  "notifications": [
    {
      "id": "note-1",
      "title": "New assignment posted",
      "body": "Build a secure course API is due on 20 July 2026.",
      "type": "assignment",
      "read": false
    },
    {
      "id": "note-2",
      "title": "Upcoming class",
      "body": "Normalization and relational integrity is scheduled for 15 July 2026.",
      "type": "classroom",
      "read": false
    }
  ],
  "announcements": [
    {
      "id": "announce-1",
      "type": "exam",
      "title": "ICT 351 mid-semester exam",
      "body": "Covers weeks 1 to 4. Bring your student card.",
      "eventAt": "2026-08-10T09:00:00.000Z",
      "audienceType": "program",
      "programId": "prog-ict",
      "courseId": null,
      "authorId": "u-lecturer-1",
      "createdAt": "2026-07-20T08:00:00.000Z"
    },
    {
      "id": "announce-2",
      "type": "announcement",
      "title": "Semester registration deadline",
      "body": "All students must confirm registration by the end of the month.",
      "eventAt": "2026-08-31T17:00:00.000Z",
      "audienceType": "all",
      "programId": null,
      "courseId": null,
      "authorId": "u-admin-1",
      "createdAt": "2026-07-18T08:00:00.000Z"
    }
  ],
  "tutorials": [
    {
      "id": "tutorial-1",
      "title": "REST API fundamentals",
      "description": "A walkthrough of building a secure REST API from scratch.",
      "videoUrl": "https://www.youtube.com/results?search_query=rest+api+fundamentals",
      "programId": "prog-ict",
      "authorId": "u-lecturer-1",
      "createdAt": "2026-06-01T08:00:00.000Z"
    }
  ],
  "materials": [],
  "presentations": [],
  "messages": [],
  "analytics": {
    "activeStudents": 118,
    "attendanceRate": 86,
    "submissionRate": 74,
    "averageGrade": 79,
    "weeklyEngagement": [64, 72, 68, 81, 77, 88, 84],
    "courseCompletion": [72, 58, 64, 47]
  }
}
;

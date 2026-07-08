window.VFU_SEED_STATE = {
  "institution": {
    "name": "VFU E-Learning Classroom",
    "tagline": "Interactive learning, attendance, collaboration, and academic monitoring.",
    "term": "June 2026 Semester"
  },
  "users": [
    {
      "id": "u-student-1",
      "name": "Alex Likando",
      "email": "student@vfu.local",
      "role": "student",
      "program": "BSc Information and Communication Technology",
      "avatar": "AL"
    },
    {
      "id": "u-lecturer-1",
      "name": "Dr. Naomi Banda",
      "email": "lecturer@vfu.local",
      "role": "lecturer",
      "program": "School of ICT",
      "avatar": "NB"
    },
    {
      "id": "u-admin-1",
      "name": "System Administrator",
      "email": "admin@vfu.local",
      "role": "admin",
      "program": "Academic Registry",
      "avatar": "SA"
    }
  ],
  "courses": [
    {
      "id": "course-web",
      "code": "ICT 351",
      "title": "Web Application Development",
      "lecturerId": "u-lecturer-1",
      "department": "ICT",
      "progress": 72,
      "color": "#2563eb",
      "schedule": "Mon and Wed, 09:00",
      "room": "Virtual Room A",
      "enrolled": 42
    },
    {
      "id": "course-db",
      "code": "ICT 322",
      "title": "Database Systems",
      "lecturerId": "u-lecturer-1",
      "department": "ICT",
      "progress": 58,
      "color": "#059669",
      "schedule": "Tue, 11:00",
      "room": "Virtual Room B",
      "enrolled": 38
    },
    {
      "id": "course-net",
      "code": "ICT 311",
      "title": "Computer Networks",
      "lecturerId": "u-lecturer-1",
      "department": "ICT",
      "progress": 64,
      "color": "#d97706",
      "schedule": "Thu, 14:00",
      "room": "Virtual Lab",
      "enrolled": 45
    }
  ],
  "classSessions": [
    {
      "id": "session-live",
      "courseId": "course-web",
      "title": "REST APIs and secure session design",
      "startsAt": "2026-06-21T17:30:00.000Z",
      "duration": 90,
      "status": "Live",
      "participants": 34
    },
    {
      "id": "session-next",
      "courseId": "course-db",
      "title": "Normalization and relational integrity",
      "startsAt": "2026-06-22T08:00:00.000Z",
      "duration": 75,
      "status": "Scheduled",
      "participants": 0
    }
  ],
  "attendance": [
    {
      "id": "att-1",
      "sessionId": "session-live",
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
      "dueAt": "2026-06-25T23:59:00.000Z",
      "points": 20,
      "status": "Open"
    },
    {
      "id": "assignment-er",
      "courseId": "course-db",
      "title": "E-learning database ER diagram",
      "dueAt": "2026-06-28T23:59:00.000Z",
      "points": 15,
      "status": "Open"
    },
    {
      "id": "assignment-routing",
      "courseId": "course-net",
      "title": "Network routing practical",
      "dueAt": "2026-07-02T23:59:00.000Z",
      "points": 10,
      "status": "Draft"
    }
  ],
  "submissions": [
    {
      "id": "sub-1",
      "assignmentId": "assignment-er",
      "courseId": "course-db",
      "userId": "u-student-1",
      "text": "Initial ER model submitted for review.",
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
  "notifications": [
    {
      "id": "note-1",
      "title": "Live class in progress",
      "body": "Web Application Development is live. Attendance is open.",
      "type": "classroom",
      "read": false
    },
    {
      "id": "note-2",
      "title": "Assignment deadline",
      "body": "Secure course API is due on 25 June 2026.",
      "type": "assignment",
      "read": false
    }
  ],
  "analytics": {
    "activeStudents": 118,
    "attendanceRate": 86,
    "submissionRate": 74,
    "averageGrade": 79,
    "weeklyEngagement": [64, 72, 68, 81, 77, 88, 84],
    "courseCompletion": [72, 58, 64]
  }
}
;

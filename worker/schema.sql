-- worldgym-schedule D1 schema
-- Mirrors the old Firestore collections: classes, branches, meta/filterOptions.
-- SQL supports multiple IN clauses per query, so unlike Firestore we don't need
-- the combinatorial composite indexes that firestore.indexes.json had.

DROP TABLE IF EXISTS classes;
CREATE TABLE classes (
  id TEXT PRIMARY KEY,
  branchSlug TEXT NOT NULL,
  branchName TEXT NOT NULL,
  date TEXT NOT NULL,
  dayOfWeek INTEGER NOT NULL,
  startTime TEXT NOT NULL,
  startHour TEXT NOT NULL DEFAULT '',
  className TEXT NOT NULL,
  teacherName TEXT NOT NULL,
  teacherEmpNo TEXT NOT NULL DEFAULT '',
  roomName TEXT NOT NULL,
  isSubstitute INTEGER NOT NULL DEFAULT 0,
  scrapedAt TEXT NOT NULL
);

CREATE INDEX idx_classes_date ON classes(date, startTime);
CREATE INDEX idx_classes_branch ON classes(branchSlug, date, startTime);
CREATE INDEX idx_classes_className ON classes(className);
CREATE INDEX idx_classes_teacherName ON classes(teacherName);
CREATE INDEX idx_classes_teacherEmpNo ON classes(teacherEmpNo);
CREATE INDEX idx_classes_dayOfWeek ON classes(dayOfWeek);
CREATE INDEX idx_classes_roomName ON classes(roomName);
CREATE INDEX idx_classes_startHour ON classes(startHour);

DROP TABLE IF EXISTS branches;
CREATE TABLE branches (
  slug TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  region TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

DROP TABLE IF EXISTS meta_filter_options;
CREATE TABLE meta_filter_options (
  id TEXT PRIMARY KEY,
  classNames TEXT NOT NULL,
  teacherNames TEXT NOT NULL,
  updatedAt TEXT NOT NULL
);

DROP TABLE IF EXISTS reminders;
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  branchSlug TEXT NOT NULL,
  branchName TEXT NOT NULL,
  className TEXT NOT NULL,
  teacherName TEXT NOT NULL,
  roomName TEXT NOT NULL,
  dayOfWeek INTEGER NOT NULL,
  startTime TEXT NOT NULL,
  classAt TEXT NOT NULL,
  remindAt TEXT NOT NULL,
  subscriptionEndpoint TEXT NOT NULL,
  pushSubscription TEXT NOT NULL,
  clickUrl TEXT NOT NULL DEFAULT '',
  sent INTEGER NOT NULL DEFAULT 0,
  createdAt TEXT NOT NULL
);

CREATE INDEX idx_reminders_pending ON reminders(sent, remindAt);
CREATE INDEX idx_reminders_endpoint ON reminders(subscriptionEndpoint);

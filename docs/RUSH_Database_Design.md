# RUSH! — Database Design

MySQL 8.0 (8.0.16+) relational model for **RUSH!**, a web app for learning
English and Korean through private rooms and real-time multiplayer quizzes.

| File | Content |
|---|---|
| `RUSH_ERD.mdj` | StarUML 6 project: diagram **RUSH! ERD**, with entities grouped by area in the Model Explorer |
| `rush_schema.sql` | MySQL DDL (`CREATE TABLE`) |
| `RUSH_Database_Design.md` | This document |
| `generator/generate_rush_model.py` | Single source of truth: regenerates the three files above |
| `generator/test_schema.sh` | Behavioural tests of the schema on a MySQL 8 server (Docker) |

All three outputs come from the same table definitions, so the diagram, the SQL
and this document always match. **To change the model, edit the generator and run**
`python generator/generate_rush_model.py`. Editing the `.mdj` or `.sql` by hand
would make them drift apart.

**Reading the diagram:** the key column shows `PK` (primary key), `FK` (foreign key),
`N` (nullable) and `U` (unique). Crow's-foot notation. A solid line is an *identifying*
relationship (the FK is part of the child's PK); a dashed line is non-identifying.
Defaults, composite UNIQUE/CHECK constraints and application rules are in each
element's **Documentation** field in StarUML.

**Conventions:** singular `snake_case` names, `BIGINT UNSIGNED AUTO_INCREMENT`
surrogate keys named `<entity>_id` (short form for compound names, e.g.
`option_id` in `answer_option`, `session_id` in `quiz_session`), FK columns
named after the referenced key or its role (`owner_user_id`, `host_user_id`),
composite keys for junction tables,
`created_at` / `updated_at` as `DATETIME`, URLs as `VARCHAR(2048)` (media lives in
external cloud storage), and `utf8mb4` everywhere so Korean text is supported.

## 1. Tables

20 tables in 6 groups.

### User Management

#### 1. `user`

Registered account. Email and username are unique; passwords are stored only as hashes. Email is immutable after registration.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `user_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `full_name` | VARCHAR(100) |  | NO |  |
| `username` | VARCHAR(30) | UQ | NO |  |
| `email` | VARCHAR(255) | UQ | NO | Immutable after registration (backend rule). |
| `password_hash` | VARCHAR(255) |  | NO | bcrypt/argon2 hash; never plain text. |
| `profile_picture_url` | VARCHAR(2048) |  | YES |  |
| `description` | TEXT |  | YES | Personal description shown on the profile. |
| `learning_language` | ENUM('ENGLISH','KOREAN') |  | YES | Language the user is learning (not collected at registration, so nullable). |
| `account_role` | ENUM('USER','SUPERADMIN') |  | NO | DEFAULT 'USER' |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP; ON UPDATE CURRENT_TIMESTAMP |

* App rule: email cannot be changed after registration (reject UPDATE of email in the backend).

#### 2. `user_preferences`

1:1 extension of user holding the two independent language settings. Row created in the same transaction as the user.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `user_id` | BIGINT UNSIGNED | PK, FK → user.user_id | NO | ON DELETE CASCADE |
| `interface_language` | ENUM('ENGLISH','KOREAN') |  | NO | DEFAULT 'ENGLISH' |
| `translation_target_language` | ENUM('ENGLISH','KOREAN') |  | NO | DEFAULT 'KOREAN' |
| `updated_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP; ON UPDATE CURRENT_TIMESTAMP |

* App rule: Insert the preferences row together with the user row (exactly one per user).

### Rooms and Membership

#### 3. `room`

Private room. All rooms are private: there is no visibility column. owner_user_id is the single source of truth for the owner.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `room_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `owner_user_id` | BIGINT UNSIGNED | FK → user.user_id | NO | ON DELETE CASCADE |
| `name` | VARCHAR(100) |  | NO |  |
| `description` | TEXT |  | NO |  |
| `cover_image_url` | VARCHAR(2048) |  | NO |  |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP; ON UPDATE CURRENT_TIMESTAMP |

* App rule: Max 10 rooms per owner (count before INSERT, inside a transaction).
* App rule: Creating a room also inserts the owner's room_membership row with role OWNER.

#### 4. `room_membership`

Current members of a room (junction user <-> room). Rows are deleted when a user leaves or is removed; no history is kept.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `room_id` | BIGINT UNSIGNED | PK, FK → room.room_id | NO | ON DELETE CASCADE |
| `user_id` | BIGINT UNSIGNED | PK, FK → user.user_id | NO | ON DELETE CASCADE |
| `membership_role` | ENUM('OWNER','ADMIN','MEMBER') |  | NO | DEFAULT 'MEMBER' |
| `joined_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `owner_flag` | TINYINT |  | YES | STORED GENERATED: `IF(membership_role = 'OWNER', 1, NULL)`; STORED generated helper: 1 for the OWNER row, NULL otherwise. UNIQUE(room_id, owner_flag) allows at most one OWNER membership per room. |

* UNIQUE `uq_room_membership_one_owner` (room_id, owner_flag)
* App rule: Max 40 memberships per room including the owner (SELECT ... FOR UPDATE on the room, count, then insert).
* App rule: Only OWNER/ADMIN can remove members; any member can leave (delete their own row).
* App rule: The OWNER membership must belong to room.owner_user_id and cannot be removed; the owner deletes the room instead of leaving it.

#### 5. `room_invitation`

Expiring invitation link. The URL (and its QR code) carries a random token; only its SHA-256 hash is stored.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `invitation_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `room_id` | BIGINT UNSIGNED | FK → room.room_id | NO | ON DELETE CASCADE |
| `created_by_user_id` | BIGINT UNSIGNED | FK → user.user_id | NO | ON DELETE CASCADE |
| `invited_user_id` | BIGINT UNSIGNED | FK → user.user_id | YES | ON DELETE CASCADE; Set when the invitation is addressed to a specific registered user (triggers the invitation email); NULL for a link shared externally. |
| `token_hash` | CHAR(64) | UQ | NO | SHA-256 (hex) of the token embedded in the link. |
| `expires_at` | DATETIME |  | NO |  |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |

* CHECK `chk_room_invitation_expiry`: `expires_at > created_at`
* App rule: A link is valid only if expires_at > NOW(); joining also re-checks the 40-member limit.
* App rule: Only OWNER/ADMIN may create invitations (see open questions).

#### 6. `topic`

Room topic. PREDEFINED topics are managed by a SUPERADMIN and have no creator; CUSTOM topics belong to the user who created them.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `topic_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `name` | VARCHAR(50) |  | NO |  |
| `topic_type` | ENUM('PREDEFINED','CUSTOM') |  | NO |  |
| `created_by_user_id` | BIGINT UNSIGNED | FK → user.user_id | YES | ON DELETE CASCADE; NULL for PREDEFINED topics; required for CUSTOM. |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |

* UNIQUE `uq_topic_creator_name` (created_by_user_id, name)
* App rule: topic_type = 'CUSTOM' <=> created_by_user_id IS NOT NULL (MySQL forbids CHECK on a column used by a cascading FK).
* App rule: PREDEFINED topic names must be unique (NULL creator is not covered by the UNIQUE key).
* App rule: Only SUPERADMIN can create/edit PREDEFINED topics.

#### 7. `room_topic`

Junction room <-> topic (N:M).

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `room_id` | BIGINT UNSIGNED | PK, FK → room.room_id | NO | ON DELETE CASCADE |
| `topic_id` | BIGINT UNSIGNED | PK, FK → topic.topic_id | NO | ON DELETE CASCADE |

### Quiz Management

#### 8. `quiz`

Quiz owned permanently by its creator. Exists independently of rooms. is_in_library = FALSE marks a quiz created directly from a room, which is not shown in the creator's personal library.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `quiz_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `creator_user_id` | BIGINT UNSIGNED | FK → user.user_id | NO | ON DELETE CASCADE; Permanent owner; never updated (no ownership transfer). |
| `title` | VARCHAR(150) |  | NO |  |
| `description` | TEXT |  | NO |  |
| `quiz_status` | ENUM('DRAFT','PUBLISHED') |  | NO | DEFAULT 'DRAFT' |
| `is_in_library` | BOOLEAN |  | NO | DEFAULT TRUE; FALSE when the quiz was created from inside a room. |
| `total_time_limit_seconds` | SMALLINT UNSIGNED |  | NO | DEFAULT 300; ONE global time limit for the whole quiz in a live session (60–3600 s, CHECK `chk_quiz_total_time_limit`). Added 2026-11 (see "Schema changes" below). |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP; ON UPDATE CURRENT_TIMESTAMP |

* App rule: Max 15 quizzes per creator.
* App rule: creator_user_id is never updated.
* App rule: Only the creator can delete the quiz and manage its collaborators; creator and collaborators can edit its content.
* App rule: updated_at is refreshed whenever the quiz's questions, options, pairs or media change (ON UPDATE only covers the quiz row itself).

#### 9. `quiz_collaborator`

Users invited by the quiz owner to edit its content (N:M).

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `quiz_id` | BIGINT UNSIGNED | PK, FK → quiz.quiz_id | NO | ON DELETE CASCADE |
| `user_id` | BIGINT UNSIGNED | PK, FK → user.user_id | NO | ON DELETE CASCADE |
| `added_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |

* App rule: The creator cannot be added as a collaborator.
* App rule: Room ADMINs get no implicit collaborator rights.

#### 10. `room_quiz`

Quizzes available in a room (N:M). Deleting a row only removes the quiz from that room.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `room_id` | BIGINT UNSIGNED | PK, FK → room.room_id | NO | ON DELETE CASCADE |
| `quiz_id` | BIGINT UNSIGNED | PK, FK → quiz.quiz_id | NO | ON DELETE CASCADE |
| `added_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |

* App rule: Only OWNER/ADMIN of the room can insert/delete rows.

### Questions and Answers

#### 11. `question`

Question of a quiz with its own time limit and points. correct_text_answer holds the single accepted answer for OPEN_ANSWER and FILL_IN_THE_BLANK questions.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `question_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `quiz_id` | BIGINT UNSIGNED | FK → quiz.quiz_id | NO | ON DELETE CASCADE |
| `question_text` | TEXT |  | NO | For FILL_IN_THE_BLANK the text contains the blank marker (e.g. ___). |
| `question_type` | ENUM('MULTIPLE_CHOICE','TRUE_FALSE','OPEN_ANSWER','FILL_IN_THE_BLANK','MATCHING') |  | NO |  |
| `point_value` | INT UNSIGNED |  | NO | DEFAULT 100 |
| `time_limit_seconds` | SMALLINT UNSIGNED |  | NO | DEFAULT 30; **legacy since 2026-11**: kept for existing data, no longer used (live sessions use `quiz.total_time_limit_seconds`). |
| `display_order` | TINYINT UNSIGNED |  | NO | 1..25, unique per quiz (also caps a quiz at 25 questions). |
| `correct_text_answer` | VARCHAR(255) |  | YES | Stored lowercase; compared with the lowercased participant answer. |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `updated_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP; ON UPDATE CURRENT_TIMESTAMP |

* UNIQUE `uq_question_quiz_order` (quiz_id, display_order)
* CHECK `chk_question_points`: `point_value > 0`
* CHECK `chk_question_time_limit`: `time_limit_seconds > 0`
* CHECK `chk_question_order`: `display_order BETWEEN 1 AND 25`
* CHECK `chk_question_text_answer`: `(question_type IN ('OPEN_ANSWER','FILL_IN_THE_BLANK') AND correct_text_answer IS NOT NULL) OR (question_type NOT IN ('OPEN_ANSWER','FILL_IN_THE_BLANK') AND correct_text_answer IS NULL)`
* App rule: answer_option rows only for MULTIPLE_CHOICE / TRUE_FALSE; matching_pair rows only for MATCHING.
* App rule: MULTIPLE_CHOICE: 2..10 options, exactly one correct.
* App rule: TRUE_FALSE: exactly two options ('TRUE','FALSE'), exactly one correct.
* App rule: MATCHING: at least 2 pairs.
* App rule: A quiz can be PUBLISHED only if every question has a complete correct answer.

#### 12. `answer_option`

Selectable option for MULTIPLE_CHOICE and TRUE_FALSE questions.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `option_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `question_id` | BIGINT UNSIGNED | FK → question.question_id | NO | ON DELETE CASCADE |
| `option_text` | VARCHAR(255) |  | NO |  |
| `is_correct` | BOOLEAN |  | NO | DEFAULT FALSE |
| `display_order` | TINYINT UNSIGNED |  | NO | 1..10, unique per question (caps options at 10). |
| `correct_flag` | TINYINT |  | YES | STORED GENERATED: `IF(is_correct, 1, NULL)`; STORED generated helper; UNIQUE(question_id, correct_flag) allows at most one correct option. |

* UNIQUE `uq_answer_option_order` (question_id, display_order)
* UNIQUE `uq_answer_option_one_correct` (question_id, correct_flag)
* CHECK `chk_answer_option_order`: `display_order BETWEEN 1 AND 10`
* App rule: At least one correct option (the UNIQUE key only guarantees at most one).

#### 13. `matching_pair`

Correct left/right pair of a MATCHING question.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `pair_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `question_id` | BIGINT UNSIGNED | FK → question.question_id | NO | ON DELETE CASCADE |
| `left_item` | VARCHAR(255) |  | NO |  |
| `right_item` | VARCHAR(255) |  | NO |  |
| `display_order` | TINYINT UNSIGNED |  | NO |  |

* UNIQUE `uq_matching_pair_order` (question_id, display_order)
* UNIQUE `uq_matching_pair_left` (question_id, left_item)
* UNIQUE `uq_matching_pair_right` (question_id, right_item)
* CHECK `chk_matching_pair_order`: `display_order >= 1`

#### 14. `question_media`

Image, audio or video attached to a question. Only the URL of the file in external cloud storage is stored.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `media_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `question_id` | BIGINT UNSIGNED | FK → question.question_id | NO | ON DELETE CASCADE |
| `media_type` | ENUM('IMAGE','AUDIO','VIDEO') |  | NO |  |
| `media_url` | VARCHAR(2048) |  | NO |  |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |

* App rule: Videos are validated/transcoded to max 720p before the URL is stored.

### Game Sessions

#### 15. `quiz_session`

One real-time play of a quiz inside a room, started by an OWNER/ADMIN who acts as host.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `session_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `room_id` | BIGINT UNSIGNED | FK → room.room_id | NO | ON DELETE CASCADE |
| `quiz_id` | BIGINT UNSIGNED | FK → quiz.quiz_id | NO | ON DELETE CASCADE |
| `host_user_id` | BIGINT UNSIGNED | FK → user.user_id | YES | ON DELETE SET NULL; NULL if the host later deletes their account (keeps the other participants' history). |
| `session_status` | ENUM('WAITING','IN_PROGRESS','COMPLETED','CANCELLED') |  | NO | DEFAULT 'WAITING' |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `started_at` | DATETIME |  | YES |  |
| `ended_at` | DATETIME |  | YES |  |
| `winner_user_id` | BIGINT UNSIGNED | FK → user.user_id | YES | ON DELETE SET NULL; the participant with the highest final score (ties broken by the earliest `finished_at`, then the lowest user id). NULL when the session was cancelled or had no participants. Added 2026-11. |
| `active_flag` | TINYINT |  | YES | STORED GENERATED: `IF(session_status IN ('WAITING','IN_PROGRESS'), 1, NULL)`; STORED generated helper: 1 while the session is active, NULL otherwise. UNIQUE(room_id, active_flag) => one active session per room. (Not derived from room_id: InnoDB rejects a generated column whose base column is a cascading FK.) |

* UNIQUE `uq_quiz_session_one_active` (room_id, active_flag)
* CHECK `chk_quiz_session_times`: `ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at`
* App rule: Only OWNER/ADMIN of the room can create a session.
* App rule: Participants are inserted only while status = 'WAITING'; none after IN_PROGRESS.
* App rule: The quiz must be associated with the room (room_quiz) and PUBLISHED.

#### 16. `quiz_attempt`

Participation of one user in one session; stores the final score.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `attempt_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `session_id` | BIGINT UNSIGNED | FK → quiz_session.session_id | NO | ON DELETE CASCADE |
| `user_id` | BIGINT UNSIGNED | FK → user.user_id | NO | ON DELETE CASCADE |
| `total_score` | INT UNSIGNED |  | NO | DEFAULT 0; Final score written when the session ends (= SUM(user_answer.points_earned)). |
| `joined_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `disconnected_at` | DATETIME |  | YES | Set on disconnect during the game; cleared when the participant reconnects. |
| `finished_at` | DATETIME |  | YES | When the participant answered every question. Finishing ends the session for everyone, so at most one participant (the first to finish) has it — which is not necessarily the winner. NULL when the session ended on the global time limit before anyone finished. Added 2026-11. |

* UNIQUE `uq_quiz_attempt_session_user` (session_id, user_id)
* App rule: Participant must be a room member when the session starts.

#### 17. `user_answer`

Answer submitted by a participant to one question, with its evaluated correctness and points.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `user_answer_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `attempt_id` | BIGINT UNSIGNED | FK → quiz_attempt.attempt_id | NO | ON DELETE CASCADE |
| `question_id` | BIGINT UNSIGNED | FK → question.question_id | NO | ON DELETE CASCADE |
| `selected_option_id` | BIGINT UNSIGNED | FK → answer_option.option_id | YES | ON DELETE SET NULL; MULTIPLE_CHOICE / TRUE_FALSE. |
| `text_answer` | VARCHAR(255) |  | YES | OPEN_ANSWER / FILL_IN_THE_BLANK, as typed. |
| `is_correct` | BOOLEAN |  | NO | DEFAULT FALSE |
| `points_earned` | INT UNSIGNED |  | NO | DEFAULT 0 |
| `answered_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |

* UNIQUE `uq_user_answer_attempt_question` (attempt_id, question_id)
* App rule: question must belong to the session's quiz.
* App rule: By question type: selected_option_id for MULTIPLE_CHOICE / TRUE_FALSE, text_answer for OPEN_ANSWER / FILL_IN_THE_BLANK, user_answer_match rows for MATCHING (not a CHECK: MySQL forbids CHECK on a column used by a SET NULL foreign key).
* App rule: Answers are accepted only within the question's time limit.

#### 18. `user_answer_match`

For MATCHING questions: which right item the participant matched to each left item. Correct when left_pair_id = selected_right_pair_id.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `user_answer_id` | BIGINT UNSIGNED | PK, FK → user_answer.user_answer_id | NO | ON DELETE CASCADE |
| `left_pair_id` | BIGINT UNSIGNED | PK, FK → matching_pair.pair_id | NO | ON DELETE CASCADE |
| `selected_right_pair_id` | BIGINT UNSIGNED | FK → matching_pair.pair_id | NO | ON DELETE CASCADE |

* App rule: Both pairs must belong to the answered question.

### Translation and Vocabulary

#### 19. `translation_cache`

Shared translation of one word in one direction (Google Translate) plus the OpenAI contextual explanation. Reused by all users to avoid repeated API calls.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `translation_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `source_word` | VARCHAR(100) |  | NO | Normalized (trimmed, lowercase for English). Binary collation. |
| `source_language` | ENUM('ENGLISH','KOREAN') |  | NO |  |
| `target_language` | ENUM('ENGLISH','KOREAN') |  | NO |  |
| `translated_word` | VARCHAR(255) |  | NO |  |
| `contextual_explanation` | TEXT |  | YES | NULL until/unless the OpenAI call succeeds. |
| `created_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |

* UNIQUE `uq_translation_cache_word` (source_word, source_language, target_language)
* CHECK `chk_translation_cache_direction`: `source_language <> target_language`

#### 20. `saved_word`

A user's personal vocabulary entry (also the translation history). Personal data only; the translation itself is shared and read-only.

| Column | Type | Key | Null | Default / notes |
|---|---|---|---|---|
| `saved_word_id` | BIGINT UNSIGNED | PK | NO | AUTO_INCREMENT |
| `user_id` | BIGINT UNSIGNED | FK → user.user_id | NO | ON DELETE CASCADE |
| `translation_id` | BIGINT UNSIGNED | FK → translation_cache.translation_id | NO | ON DELETE RESTRICT |
| `personal_note` | TEXT |  | YES |  |
| `is_favorite` | BOOLEAN |  | NO | DEFAULT FALSE |
| `saved_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP |
| `last_looked_up_at` | DATETIME |  | NO | DEFAULT CURRENT_TIMESTAMP; Updated each time the user looks the word up again. |

* UNIQUE `uq_saved_word_user_translation` (user_id, translation_id)
* App rule: Search and export are queries over saved_word JOIN translation_cache.

### Schema changes (2026-11): global quiz timer and highest-score winner

* `quiz.total_time_limit_seconds`, `quiz_session.winner_user_id` (FK `fk_quiz_session_winner_user_id`,
  ON DELETE SET NULL) and `quiz_attempt.finished_at` were added. `question.time_limit_seconds` is kept
  but unused.
* Existing databases are upgraded by `backend/src/db/migrations.ts` (run automatically when the
  backend starts, or with `npm run db:migrate`). It only adds columns and constraints, and fills
  `total_time_limit_seconds` of existing quizzes with the sum of their old per-question limits,
  rounded up to whole minutes and kept within 1–60 minutes. No data is deleted.

## 2. Relationships

Read as *parent (cardinality) — relationship — child (cardinality)*. Every relationship is one FK.

| # | Parent | Card. | Relationship | Child | Card. | FK column | Type | ON DELETE |
|---|---|---|---|---|---|---|---|---|
| 1 | `user` | 1 | configures | `user_preferences` | 1 | `user_id` | 1:1 (identifying) | CASCADE |
| 2 | `user` | 1 | owns | `room` | 0..* | `owner_user_id` | 1:N | CASCADE |
| 3 | `room` | 1 | has members | `room_membership` | 1..* | `room_id` | 1:N (identifying) | CASCADE |
| 4 | `user` | 1 | holds | `room_membership` | 0..* | `user_id` | 1:N (identifying) | CASCADE |
| 5 | `room` | 1 | issues | `room_invitation` | 0..* | `room_id` | 1:N | CASCADE |
| 6 | `user` | 1 | creates | `room_invitation` | 0..* | `created_by_user_id` | 1:N | CASCADE |
| 7 | `user` | 0..1 | receives | `room_invitation` | 0..* | `invited_user_id` | 1:N | CASCADE |
| 8 | `user` | 0..1 | creates | `topic` | 0..* | `created_by_user_id` | 1:N | CASCADE |
| 9 | `room` | 1 | is tagged with | `room_topic` | 0..* | `room_id` | 1:N (identifying) | CASCADE |
| 10 | `topic` | 1 | describes | `room_topic` | 0..* | `topic_id` | 1:N (identifying) | CASCADE |
| 11 | `user` | 1 | creates | `quiz` | 0..* | `creator_user_id` | 1:N | CASCADE |
| 12 | `quiz` | 1 | has collaborators | `quiz_collaborator` | 0..* | `quiz_id` | 1:N (identifying) | CASCADE |
| 13 | `user` | 1 | collaborates on | `quiz_collaborator` | 0..* | `user_id` | 1:N (identifying) | CASCADE |
| 14 | `room` | 1 | offers | `room_quiz` | 0..* | `room_id` | 1:N (identifying) | CASCADE |
| 15 | `quiz` | 1 | is added to | `room_quiz` | 0..* | `quiz_id` | 1:N (identifying) | CASCADE |
| 16 | `quiz` | 1 | contains | `question` | 0..* | `quiz_id` | 1:N | CASCADE |
| 17 | `question` | 1 | offers | `answer_option` | 0..* | `question_id` | 1:N | CASCADE |
| 18 | `question` | 1 | defines | `matching_pair` | 0..* | `question_id` | 1:N | CASCADE |
| 19 | `question` | 1 | includes | `question_media` | 0..* | `question_id` | 1:N | CASCADE |
| 20 | `room` | 1 | hosts | `quiz_session` | 0..* | `room_id` | 1:N | CASCADE |
| 21 | `quiz` | 1 | is played in | `quiz_session` | 0..* | `quiz_id` | 1:N | CASCADE |
| 22 | `user` | 0..1 | hosts | `quiz_session` | 0..* | `host_user_id` | 1:N | SET NULL |
| 23 | `quiz_session` | 1 | has participants | `quiz_attempt` | 0..* | `session_id` | 1:N | CASCADE |
| 24 | `user` | 1 | participates | `quiz_attempt` | 0..* | `user_id` | 1:N | CASCADE |
| 25 | `quiz_attempt` | 1 | submits | `user_answer` | 0..* | `attempt_id` | 1:N | CASCADE |
| 26 | `question` | 1 | is answered in | `user_answer` | 0..* | `question_id` | 1:N | CASCADE |
| 27 | `answer_option` | 0..1 | is selected in | `user_answer` | 0..* | `selected_option_id` | 1:N | SET NULL |
| 28 | `user_answer` | 1 | details | `user_answer_match` | 0..* | `user_answer_id` | 1:N (identifying) | CASCADE |
| 29 | `matching_pair` | 1 | is left item of | `user_answer_match` | 0..* | `left_pair_id` | 1:N (identifying) | CASCADE |
| 30 | `matching_pair` | 1 | is chosen right item of | `user_answer_match` | 0..* | `selected_right_pair_id` | 1:N | CASCADE |
| 31 | `user` | 1 | saves | `saved_word` | 0..* | `user_id` | 1:N | CASCADE |
| 32 | `translation_cache` | 1 | is saved as | `saved_word` | 0..* | `translation_id` | 1:N | RESTRICT |

**Many-to-many relationships** (resolved by junction tables):

| N:M | Junction table |
|---|---|
| user ↔ room (membership with role) | `room_membership` |
| room ↔ topic | `room_topic` |
| quiz ↔ user (collaborators) | `quiz_collaborator` |
| room ↔ quiz | `room_quiz` |
| user ↔ quiz_session (participants) | `quiz_attempt` |
| user ↔ translation_cache (vocabulary) | `saved_word` |

## 3. Key design decisions

1. **Twenty tables instead of the 22 proposed.**
   * `QUESTION_ACCEPTED_ANSWER` was merged into `question.correct_text_answer`. The spec says
     OPEN_ANSWER and FILL_IN_THE_BLANK have exactly **one** correct answer, so a 1:N table added
     nothing. A CHECK requires this column for those two types and forbids it for the others.
   * `NOTIFICATION` was left out. The four email notifications are sent when the event happens,
     and their recipients can be read from existing tables. Nothing requires an inbox, read
     status or history. The diagram has a *Notifications* frame that explains this.
2. **TRUE_FALSE uses `answer_option`.** It is stored as two option rows ("TRUE"/"FALSE"),
   so one mechanism serves both choice-based types.
3. **One answer table, typed by question.** `user_answer` stores `selected_option_id`
   (choice types) or `text_answer` (text types). MATCHING details go in
   `user_answer_match`, one row per left item. `is_correct` and `points_earned` are stored when
   the answer is evaluated, so history does not depend on later edits to the quiz.
4. **Room owner.** `room.owner_user_id` is the single source of truth (exactly one owner,
   enforced by `NOT NULL`). The owner also has a `room_membership` row with role `OWNER`,
   so the 40-member limit counts the owner. The stored generated column
   `owner_flag` + `UNIQUE(room_id, owner_flag)` allows at most one OWNER row per room.
5. **DB-level guards built from generated columns and CHECKs:**
   * `quiz_session.active_flag` + UNIQUE(room_id, active_flag) → at most **one active session per room**.
   * `answer_option.correct_flag` + UNIQUE → at most **one correct option** per question.
   * `display_order` CHECK 1..25 + UNIQUE per quiz → at most **25 questions** per quiz.
   * `display_order` CHECK 1..10 + UNIQUE per question → at most **10 options** per question.
6. **Personal library vs. room-created quizzes.** `quiz.is_in_library` (default TRUE) is set
   to FALSE when a quiz is created from inside a room. The quiz still exists and still
   belongs to its creator; it is just hidden from their library view. See open question Q3.
7. **Invitations.** Only a SHA-256 hash of the token is stored (`token_hash`, UNIQUE), the same
   way passwords are stored as hashes. The URL/QR code carries the raw token.
   `invited_user_id` is nullable: when set, the invitation is addressed to a registered
   user and triggers the invitation email; when NULL, it is a link shared externally.
8. **Shared translation vs. personal vocabulary.** `translation_cache` holds one row per
   (word, source language, target language) and is shared by everyone, which avoids repeated
   Google Translate/OpenAI calls. `saved_word` holds only personal data (note, favourite,
   dates) and is unique per (user, translation). FK uses `RESTRICT` so a cache entry in use
   cannot be purged.
9. **Deletion behaviour.** Almost every FK is `ON DELETE CASCADE`, which gives the required
   clean-up without orphans:
   * deleting a **user** removes their preferences, owned rooms, quizzes, memberships,
     collaborations, invitations, custom topics, attempts and saved words;
   * deleting a **room** removes memberships, invitations, room_topic, room_quiz and its
     sessions. Quizzes are untouched;
   * deleting a **quiz** removes questions → options/pairs/media, room_quiz rows and its
     sessions (history need not be kept).
   Exceptions: `quiz_session.host_user_id` is `SET NULL`, so a host deleting their account
   does not erase other players' results; `user_answer.selected_option_id` is `SET NULL`;
   `saved_word.translation_id` is `RESTRICT`.
10. **`quiz_attempt.total_score`** is a deliberate snapshot written once at the end of
    the session (it equals `SUM(user_answer.points_earned)`), so results and history lists
    can be read without aggregation.
11. **How each question type is stored:**

    | Type | Definition (correct answer) | Participant answer | Evaluation |
    |---|---|---|---|
    | MULTIPLE_CHOICE | 2..10 `answer_option` rows, exactly one `is_correct` | `user_answer.selected_option_id` | selected option is the correct one |
    | TRUE_FALSE | 2 `answer_option` rows ("TRUE", "FALSE"), one `is_correct` | `user_answer.selected_option_id` | same as above |
    | OPEN_ANSWER | `question.correct_text_answer` (lowercase) | `user_answer.text_answer` | `LOWER(text_answer) = correct_text_answer` |
    | FILL_IN_THE_BLANK | blank marker in `question_text` + `question.correct_text_answer` | `user_answer.text_answer` | text comparison, as above |
    | MATCHING | ≥2 `matching_pair` rows (left_item ↔ right_item) | one `user_answer` + one `user_answer_match` row per left item | every `left_pair_id = selected_right_pair_id` |

    In all cases the result is stored in `user_answer.is_correct` and `points_earned`.
12. **Simplicity.** No visibility field, password, join request, chat, leaderboard, speed
    bonus, pause or reconnection data, because none of these features exist.

## 4. Business constraints and where they are enforced

| Rule | Requirement | Enforced by |
|---|---|---|
| Unique email / username | — | DB: `UNIQUE` |
| Email immutable | cannot change | App (reject updates) |
| Passwords | hash only | App (bcrypt/argon2) → `password_hash` |
| Rooms per user | ≤ 10 | App: count `room` by `owner_user_id` in a transaction |
| Quizzes per user | ≤ 15 | App: count `quiz` by `creator_user_id` in a transaction |
| Members per room | ≤ 40 incl. owner | App: `SELECT … FOR UPDATE` on room, count memberships, insert |
| Room owners | exactly 1 | DB: `room.owner_user_id NOT NULL`; ≤1 OWNER membership via `owner_flag` UNIQUE; App keeps both in sync |
| Questions per quiz | ≤ 25 | DB: `display_order` 1..25 + UNIQUE(quiz_id, display_order) |
| Options per MC question | ≤ 10 | DB: `display_order` 1..10 + UNIQUE(question_id, display_order) |
| Correct option | exactly 1 | DB: ≤1 (`correct_flag` UNIQUE); App: ≥1 before publishing |
| TRUE_FALSE | exactly 2 options | App |
| Text answer | exactly 1 for OPEN_ANSWER / FILL_IN_THE_BLANK | DB: CHECK `chk_question_text_answer` |
| MATCHING | ≥ 2 pairs, unique left and right items | DB: UNIQUE per side; App: ≥2 |
| Active sessions per room | ≤ 1 | DB: `active_flag` + UNIQUE(room_id, active_flag) |
| Start session | OWNER/ADMIN only | App |
| Join session | only while `WAITING`; no rejoin after disconnect | App |
| Quiz owner | exactly 1, not transferable | DB: `creator_user_id NOT NULL`; App: never update it |
| Room admin ≠ collaborator | no implicit rights | App (permissions read only from `quiz_collaborator`) |
| Quiz deletion / collaborator management | creator only | App |
| Quiz content editing | creator + collaborators | App |
| Quiz last update date | reflects content edits | DB for the quiz row (`ON UPDATE`); App refreshes it when questions/options/pairs/media change |
| Remove members, add/remove room quizzes | OWNER/ADMIN only | App |
| Leave room / rejoin | delete own membership; rejoin with a valid link | DB: membership row deleted, PK allows re-insert; App checks link |
| Child rows match question type | options only for MULTIPLE_CHOICE/TRUE_FALSE, pairs only for MATCHING | App |
| Answer columns match question type | option / text / match rows | App |
| One answer per question per participant | — | DB: UNIQUE(attempt_id, question_id) |
| One participation per user per session | simultaneous sessions in different rooms allowed | DB: UNIQUE(session_id, user_id) |
| Participant / host is a room member | at session time | App (not an FK: memberships are deleted on leave, history must survive) |
| Invitation validity | not expired | App (`expires_at > NOW()`); DB CHECK `expires_at > created_at` |
| Saved word | once per user | DB: UNIQUE(user_id, translation_id) |
| Translation direction | EN↔KO only, distinct languages | DB: ENUM + CHECK |
| Video quality | ≤ 720p | App / upload pipeline (DB stores URL only) |
| Answer evaluation | lowercase exact comparison | App (`correct_text_answer` stored lowercase) |

## 5. Normalization check

* **1NF:** every column is atomic. There are no lists in columns: options, pairs, media, topics, members and answers are separate rows.
* **2NF:** every junction table with a composite key (`room_membership`, `room_topic`, `quiz_collaborator`, `room_quiz`, `user_answer_match`) has non-key columns that depend on the whole key.
* **3NF:** no non-key column depends on another non-key column. Translation data lives only in `translation_cache`, not in `saved_word`; user data lives only in `user`.
* **Deliberate, controlled redundancy:** `quiz_attempt.total_score` and `user_answer.is_correct` / `points_earned` (result snapshots taken at evaluation time), the OWNER membership row mirroring `room.owner_user_id`, and the stored generated helper columns (`owner_flag`, `correct_flag`, `active_flag`), which MySQL computes itself, so they cannot become inconsistent.
* Every FK references a primary key, and every N:M relationship uses a junction table.

## 6. Unresolved design decisions (open questions)

These are documented, not silently decided. The model supports either answer
unless noted.

1. **Automatic vs. manual saving of looked-up words.** The spec treats history and
   vocabulary as one list but does not say whether every lookup is saved. *Model impact:*
   none. With automatic saving every lookup upserts `saved_word` (updating
   `last_looked_up_at`); with manual saving rows are created only on "Save". The cache
   is filled either way.
2. **Contextual explanation caching.** The explanation is cached per word and direction. If it
   should depend on the surrounding sentence, or be written in the user's interface
   language, the cache key must be extended (e.g. an `explanation_language` column) or
   the explanation moved out of the cache.
3. **Quizzes created from a room** (`is_in_library = FALSE`): Do they count toward the
   15-quiz limit? If the quiz is removed from every room, should it be deleted, or moved into
   the library? Can the creator later add it to their library?
4. **Who can create invitation links:** only OWNER/ADMIN (assumed in the app rules) or any
   member? Are links single-use or multi-use until expiry? Is there a default expiry
   time? (Single-use would need a `used_at` column.)
5. **Targeted vs. open invitations.** The model allows both (`invited_user_id` nullable).
   Confirm whether invitations are always sent to a specific registered user.
6. **Room owner deletes their account.** Currently the room is deleted (cascade). The
   alternative, transferring ownership to an admin, is not in the spec.
7. **Editing a quiz after it has been played.** History keeps `is_correct` and
   `points_earned`, but option text and pairs are live references. If deleting or editing
   played questions must not alter history, either block editing of played quizzes or
   snapshot the question data.
8. **Adding DRAFT quizzes to rooms.** Can a DRAFT quiz be added to a room, or only a
   PUBLISHED one? Sessions are assumed to require PUBLISHED.
9. **Cancelled sessions.** Kept with status `CANCELLED` (current model) or deleted?
10. **Unanswered questions** (time-out): store a `user_answer` row with no answer and 0
    points, or no row at all?
11. **MATCHING scoring:** all-or-nothing, or partial points per correct pair? Maximum
    number of pairs?
12. **Media per question:** any number, or at most one image/audio/video? (The model allows
    any number.)
13. **Collaborator invitations:** added directly by the owner (current model), or a
    pending invitation the collaborator must accept?
14. **Default values:** `translation_target_language` defaults to KOREAN; question
    `point_value` 100 and `time_limit_seconds` 30; `learning_language` is nullable because
    it is not asked for at registration. Confirm these defaults and ranges.
15. **Predefined topic names:** must they be unique across custom topics too?
16. **Room administrators:** who can promote a member to ADMIN or demote them: only the
    owner, or admins too? The model only stores the role.

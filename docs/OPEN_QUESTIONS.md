# RUSH! — Open questions and documented assumptions

The database design (`docs/RUSH_Database_Design.md` §6) lists 16 unresolved decisions. The
application had to pick a behaviour for each so that it can run. Every assumption below is
**reversible** (application code only, no schema change) unless explicitly marked as a
*schema proposal*, and none of the schema proposals has been applied.

| # | Question | Assumption implemented | Where |
|---|---|---|---|
| A-1 (Q1) | Are looked-up words saved automatically? | **Manual.** A lookup fills `translation_cache`; the user clicks *Save* to create `saved_word`. Looking up an already-saved word refreshes `last_looked_up_at`. | `services/vocabulary.ts` |
| A-2 (Q2) | Contextual explanation cache key | Cached per (word, direction), written in English when the target is English and in Korean when the target is Korean — independent of the surrounding sentence. | `services/translation.ts` |
| A-3 (Q3) | Quizzes created from a room | They count toward the 15-quiz limit. They appear in the room, not in the library. When such a quiz is removed from its **last** room it is moved into the creator's library (`is_in_library = TRUE`) instead of being lost or deleted. | `services/rooms.ts` |
| A-4 (Q4) | Who creates invitations; single/multi use; expiry | OWNER/ADMIN only. Links are **multi-use until they expire** (single-use would need a `used_at` column). Expiry is fixed at **exactly one hour** from the server-side creation time; clients cannot choose or extend it, and expiry is enforced on the backend when previewing or accepting. | `services/invitations.ts` |
| A-5 (Q5) | Targeted vs. open invitations | Both: an open link (`invited_user_id = NULL`) or a link addressed to a registered user (by username or email), which sends the invitation email. A targeted link can only be used by that user. | `services/invitations.ts` |
| A-6 (Q6) | Owner deletes their account | Owned rooms are deleted (current cascade). The UI warns before deletion. | `services/users.ts` |
| A-7 (Q7) | **Editing a quiz after it was played** | See "Historical results" below. **Questions that have recorded answers are locked** (cannot be edited or deleted). New questions can still be added and order can change. **Confirmed by the project owner on 2026-11-05.** | `services/questions.ts` |
| A-8 (Q8) | DRAFT quizzes in rooms | Allowed (needed for quizzes created from a room). Sessions require `PUBLISHED`. | `services/sessions.ts` |
| A-9 (Q9) | Cancelled sessions | Kept with status `CANCELLED`. | `realtime/sessionEngine.ts` |
| A-10 (Q10) | Unanswered questions | A `user_answer` row with no answer, `is_correct = FALSE`, `points_earned = 0` is stored for every participant who did not answer in time (complete history). | `realtime/sessionEngine.ts` |
| A-11 (Q11) | MATCHING scoring / max pairs | **All-or-nothing** (every left item matched correctly). 2–10 pairs (same limit as answer options). | `shared/src/questions.ts` |
| A-12 (Q12) | Media per question | At most **one** media item (image, audio or video) per question. | `shared/src/questions.ts` |
| A-13 (Q13) | Collaborator invitations | Added directly by the quiz owner by username (no acceptance step). | `services/quizzes.ts` |
| A-14 (Q14) | Defaults and ranges | Defaults kept (100 points, target language KOREAN). Ranges: points 1–1000. **Since 2026-11 the time limit is one global limit per quiz**: 1–60 minutes, default 5 minutes (the per-question limit is no longer used). | `shared/src/limits.ts` |
| A-15 (Q15) | Predefined names unique across custom topics? | No. Predefined names are unique among predefined topics (case-insensitive); custom names are unique per creator (DB key). | `services/topics.ts` |
| A-16 (Q16) | Who promotes/demotes ADMINs | **Only the OWNER.** ADMINs can remove MEMBERs but not other ADMINs or the OWNER. | `services/rooms.ts` |

## Additional assumptions made during implementation

| # | Topic | Assumption |
|---|---|---|
| A-17 | Login session storage | The schema has no session table, so server-side sessions are kept in memory (`memorystore`). Restarting the backend logs everybody out. *Schema proposal (not applied):* add a `user_session` table and switch to a MySQL session store for multi-process deployments. |
| A-18 | Session host | The OWNER/ADMIN who creates the session is the host and joins as a normal participant (gets a `quiz_attempt`). Any OWNER/ADMIN of the room can start or cancel it. |
| A-19 | Leaving the waiting room / disconnects | While `WAITING`, a participant who disconnects is removed (their attempt row is deleted) and may join again. After the game starts, a disconnect sets `disconnected_at` but keeps the player's progress; the same player can reconnect (it is cleared) and resumes at their current question with the remaining global time. A disconnect never ends the game or makes anybody the winner. |
| A-20 | Game flow (2026-11) | One global timer per session, started once and never reset. Each player answers the questions at their own pace and, after each answer, sees only their own result and the correct answer for 1.5 seconds before their next question. **The winner is the participant with the highest final score** (server-authoritative). The session ends as soon as the first player answers all questions, or when the global time expires — whichever comes first. The first player to finish decides *when* the session ends, not *who* wins: finishing first never overrides a higher score, so a player with more points who has not finished still wins. Ties are broken by the earliest completion time, then by the lowest user id, so there is exactly one winner. The final standings are shown only at the end (no live leaderboard); the winner is listed first. |
| A-21 | Backend restart during a game | Timers live in memory; on startup every `WAITING`/`IN_PROGRESS` session is marked `CANCELLED`. |
| A-22 | "Session starting" email | Sent to every participant when the host starts the game. |
| A-23 | "Quiz added to room" email | Sent to every room member except the person who added it. |
| A-24 | Room cover image | `room.cover_image_url` is NOT NULL. If the user gives none, a bundled default cover URL is stored. |
| A-25 | Viewing profiles | A user can view the profile of users they share a room or a quiz with. Emails are never shown to other users. |
| A-26 | Room members and quiz content | Plain members see a room's quizzes (title, description, number of questions) but never the questions/answers. Only creators/collaborators see quiz content. |
| A-27 | Adding quizzes to rooms | An OWNER/ADMIN can add a quiz they created or collaborate on. |
| A-28 | Topics on rooms | An OWNER/ADMIN can assign predefined topics and custom topics they created. Existing assignments made by others remain. |
| A-29 | Fill in the blank | The question text must contain exactly one blank marker `___` (three or more underscores). |
| A-30 | Text answers | Compared after trimming, collapsing whitespace and lowercasing (stored lowercase, as the design says). |
| A-31 | Video ≤ 720p | Videos must be uploaded as MP4; the server reads the resolution from the MP4 `tkhd` box and rejects anything taller than 720 px (or wider than 1280 px). Videos cannot be attached by external URL because their resolution cannot be verified. Images/audio may be uploaded or given as an `https://` URL. |
| A-32 | Translation dev fallback | Without `GOOGLE_TRANSLATE_API_KEY` the translation endpoint returns `503 translation_unavailable` unless `TRANSLATION_PROVIDER=mock` is set, which produces clearly marked `[mock]` translations for local development. |
| A-34 | Translation during a live quiz | The word-translation popup is disabled on the live game screen (`/play/...`), otherwise players could translate the answers of a language quiz. It works everywhere else. |
| A-35 | Media storage in development | `STORAGE_DRIVER=local` writes uploads to `backend/uploads` and serves them at `/media` — a stand-in for cloud storage; use `STORAGE_DRIVER=s3` for real deployments. |
| A-33 | Question reordering at 25 questions | Moving a question needs one free position (the schema restricts `display_order` to 1..25 and checks uniqueness row by row). With exactly 25 questions, reordering is disabled (known limitation). |

## Historical results (requirement §11) — limitation and proposal

**Limitation.** `user_answer.is_correct` and `points_earned` are snapshots, but the question
text, options and matching pairs shown in a historical result are live rows:

* editing a question's text/options would change what old results display;
* deleting a question cascades (`fk_user_answer_question_id ON DELETE CASCADE`) and removes
  participants' answers;
* deleting an answer option sets `user_answer.selected_option_id` to NULL.

**Implemented (no schema change, reversible):** any question with at least one `user_answer`
row is read-only and cannot be deleted. Results therefore always show exactly what was played.
Deleting the *whole quiz* (owner only) still removes its sessions, as documented in design
decision 9; the confirmation dialog states this.

**Schema proposal (declined on 2026-11-05 — the lock above was kept; recorded for future reference):** to allow editing played questions, add
snapshot columns to `user_answer`:

```sql
ALTER TABLE user_answer
  ADD COLUMN question_snapshot JSON NULL COMMENT 'question text, type, options/pairs and correct answer as played';
```

and drop the cascade on `fk_user_answer_question_id` (→ `SET NULL` with a nullable column).
The generator (`generator/generate_rush_model.py`) would have to be updated so the ERD, SQL and
design document stay in sync.

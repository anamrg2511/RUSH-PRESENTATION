# RUSH!

RUSH! is a web platform for learning **English and Korean** in small groups. Users create quizzes,
organise **private rooms**, invite friends with expiring links and play **real-time multiplayer
quiz sessions**. Any word shown in the interface can be double-clicked to get a translation and a
contextual explanation, and saved to a personal vocabulary.

> **Presentation version.** This build exposes a reduced set of options in the user interface:
>
> 1. New questions can be **Multiple choice** or **True or false** only.
> 2. Question media is limited to **image uploads** (JPEG, PNG, GIF, WebP); audio, video and media URLs are not offered.
> 3. The vocabulary page has **no export** (CSV/JSON) controls.
> 4. Rooms are created and edited **without a custom cover image**; new rooms get a default cover and existing covers are kept.
>
> The backend API and the database schema are those of the full application, so data created with
> other question types or media is stored and displayed unchanged (see [Limitations](#limitations)).

Further documentation:

* [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — components, layers and the real-time protocol
* [`docs/RUSH_Database_Design.md`](docs/RUSH_Database_Design.md) — relational model (source of truth: [`database/rush_schema.sql`](database/rush_schema.sql))
* [`docs/OPEN_QUESTIONS.md`](docs/OPEN_QUESTIONS.md) — business rules that were ambiguous and how they are implemented (referenced in code as `A-n`)
* [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — colours, typography and UI components
* [`TODO.md`](TODO.md) — pending decisions and future work
* [`CONTRIBUTING.md`](CONTRIBUTING.md) — branches, commits and Pull Requests
* [`INSTRUCCIONES_PARA_TRABAJO_COLABORATIVO.txt`](INSTRUCCIONES_PARA_TRABAJO_COLABORATIVO.txt) — step-by-step team guide (Spanish)
* `RUSH_Manual_Tecnico_y_Explicacion_Completa.docx` and `RUSH_Guia_de_Comprension_del_Proyecto.docx` — technical manual and comprehension guide (Spanish)

## Features

* **Accounts:** registration, login with username or email, logout, profile (name, username, picture URL, description, learning language), password change, account deletion. Email addresses cannot be changed.
* **Preferences:** target language for word translations. The interface is English-only (the language buttons and the *Interface language* field are kept in the layout but do not change the language).
* **Private rooms:** up to 10 owned rooms per user, up to 40 members per room, topics (predefined and custom), member roles (owner, admin, member), leaving and removing members.
* **Invitations:** expiring links (1 hour – 30 days), open or addressed to a registered user, revocable; only a hash of each token is stored.
* **Quizzes:** personal library (up to 15 quizzes), draft/published status, collaborators who can edit content, quizzes reusable across rooms, up to 25 questions per quiz with points, order and one image, and one total time limit for the whole quiz (1–60 minutes).
* **Live sessions:** waiting room, one server-side global timer for the whole quiz (it never resets between questions), players advance through the questions at their own pace, answers graded on the server, per-player feedback after each answer, **the first player to answer every question wins and ends the game for everybody** (if time runs out first there is no first-finisher winner and the standings use the scores), reconnection to a running game, final standings and a results page with each player's own answers; one active session per room.
* **History:** session history per room and per user; questions that have recorded answers are locked so past results stay consistent.
* **Translation and vocabulary:** single-word EN↔KO translation (Google Cloud Translation) followed by a contextual explanation (OpenAI), shared translation cache, personal vocabulary with notes, favourites and search.
* **Notifications:** emails for invitations, member removal, quizzes added to a room and session start.
* **Administration:** SUPERADMIN users manage predefined room topics.

### How a live game works

1. The quiz creator sets **one total time limit for the whole quiz** (1–60 minutes, default 5) in the
   *Details* panel of the quiz editor. Questions have no time limit of their own.
2. An owner or admin starts a session; members join the waiting room, which shows the total time and
   the rule "the first player to answer every question wins".
3. When the host starts the game, the server sets a single deadline. Every player sees the same
   countdown (`m:ss`, "of 5 min"); it keeps running and never restarts when a player moves to the
   next question.
4. Each player answers at their own pace and briefly sees their own result after each answer.
5. **The first player to answer every question wins and the game ends immediately for everybody**,
   regardless of score. The server decides; two near-simultaneous finishes produce exactly one winner.
6. If the time runs out first, the game ends with no first-finisher winner and the standings are
   ranked by score (correct answers earn the question's points, speed earns nothing extra).
7. Everybody sees the winner (or the time-up notice) and the final standings; the results page shows
   each player's own answers. A player who loses the connection keeps their progress and can rejoin.

## Technology stack

| Layer | Technology |
|---|---|
| Frontend | React 18, TypeScript, Vite 6, Tailwind CSS 4, React Router 6, TanStack Query 5, Socket.IO client |
| Backend | Node.js 20, TypeScript, Express 4, Socket.IO 4, express-session, Zod |
| Database | MySQL 8.0.16+ accessed with Kysely + mysql2 (parameterised SQL) |
| Shared code | `shared/` npm workspace: validation schemas, business limits, grading and API types |
| Integrations | Google Cloud Translation v2, OpenAI Chat Completions, SMTP (Nodemailer), S3-compatible object storage |
| Tests | Vitest (unit and integration against MySQL), Testing Library, Playwright (end-to-end) |

## Architecture

```
Browser (React SPA)  ──REST /api──►  Express API  ──Kysely/mysql2──►  MySQL
        └──────── Socket.IO (same session cookie) ────►  SessionEngine (game state, global timer, scoring, winner)
```

* The frontend talks to the backend over a REST API and, during live games, over Socket.IO.
  The Vite development server proxies `/api`, `/media` and `/socket.io`, so everything runs on one origin.
* Authentication uses server-side sessions (`express-session`) with an HttpOnly cookie; the same
  session authenticates Socket.IO connections.
* Business rules and permission checks live in backend services; the game engine is authoritative
  for timing, grading and scores.
* Validation rules are shared between frontend and backend through the `shared/` workspace.

Details: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Project structure

```
RUSH-PRESENTATION/
├── backend/
│   ├── src/
│   │   ├── config/        environment parsing and validation
│   │   ├── db/            Kysely instance, table types, schema helpers
│   │   ├── http/          Express app, middleware, sessions, error handling
│   │   ├── routes/        REST endpoints
│   │   ├── services/      business logic and permission checks
│   │   ├── realtime/      Socket.IO server and game engine
│   │   ├── integrations/  translation providers, mailer, storage, MP4 inspection
│   │   └── scripts/       database init/reset/migrate, seed, superadmin promotion, E2E server
│   └── test/              integration tests (Vitest + Supertest + Socket.IO client)
├── frontend/
│   ├── src/
│   │   ├── api/           HTTP client and endpoint functions
│   │   ├── auth/          authentication context
│   │   ├── components/    UI components, layout, navigation, translation popup
│   │   ├── features/      pages: landing, auth, dashboard, rooms, quizzes, play, vocabulary, profile, settings, admin
│   │   └── i18n/          English interface texts
│   ├── public/            favicon and default room covers
│   └── e2e/               Playwright tests
├── shared/                schemas, limits, scoring and types used by both sides
├── database/              rush_schema.sql and the ERD (StarUML)
├── generator/             script that generates the schema, ERD and design document, plus schema tests
├── docs/                  technical documentation
├── docker-compose.yml     local MySQL 8 server
└── .env.example           configuration template
```

## Prerequisites

* Node.js 20 or later and npm 10 or later
* MySQL 8.0.16 or later — Docker with `docker compose` is the simplest option
* Google Chrome (optional) to run the end-to-end tests without downloading Playwright browsers

## Installation

```bash
npm install
```

```bash
cp .env.example .env
```

Then edit `.env` as described below.

## Environment configuration

A single `.env` file at the project root is read by the backend. Never commit it.

| Variable | Purpose |
|---|---|
| `SESSION_SECRET` | Required. Long random string, e.g. `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`. |
| `PORT`, `APP_URL`, `PUBLIC_API_URL` | Backend port and the public URLs of frontend and backend (used for invitation links, origin checks and local media URLs). |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | MySQL connection. The template matches `docker-compose.yml` (port 3307, user `root`, password `rush_root_dev`, database `rush`). |
| `DB_TEST_NAME` | Database used by the automated tests (template: `rush_test`); must differ from `DB_NAME`. |
| `TRANSLATION_PROVIDER` | `google`, `mock` (clearly marked fake translations for local use) or `none`. |
| `GOOGLE_TRANSLATE_API_KEY` | Google Cloud Translation (Basic, v2) key. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | OpenAI key and model for contextual explanations (optional). |
| `EXTERNAL_API_TIMEOUT_MS` | Timeout for each external API call (default 8000). |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | Email delivery. If `SMTP_HOST` is empty, no email is sent and messages are printed to the backend console. |
| `STORAGE_DRIVER` | `local` (files in `backend/uploads`, served at `/media`; development only) or `s3`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_PUBLIC_BASE_URL` | S3-compatible bucket used when `STORAGE_DRIVER=s3`. |

API keys are read only by the backend and are never sent to the browser.

This presentation installation uses its own databases — `DB_NAME=rush_presentation` and
`DB_TEST_NAME=rush_presentation_test` — so it does not share data with other RUSH! installations
on the same MySQL server.

## Database setup

Start MySQL with Docker:

```bash
npm run db:up
```

The container is named `rush-mysql-dev`. If a container with that name already exists (for
example from another RUSH! checkout), start it with `docker start rush-mysql-dev` instead.

Create the schema in the database named by `DB_NAME`:

```bash
npm run db:init
```

`db:init` checks that the server is MySQL 8.0.16 or later and never overwrites existing data: if the
RUSH tables already exist it stops without changes. To delete all data and recreate the tables
(asks for confirmation):

```bash
npm run db:reset
```

Databases created with an older version of the schema are upgraded automatically when the backend
starts (additive changes only, no data is deleted). The same upgrade can be run by hand:

```bash
npm run db:migrate
```

Optional demo data (users `admin`, `ana`, `ben`, `cho` with password `rush-demo-1234`, one room and
one quiz):

```bash
npm run db:seed
```

The demo quiz contains all five question types of the full application; in this version the extra
types are shown and playable but cannot be chosen for new questions.

Promote an account to SUPERADMIN:

```bash
npm run admin:promote -w backend -- <username>
```

## Running locally

Start backend (http://localhost:4000) and frontend (http://localhost:5173) together:

```bash
npm run dev
```

or separately with `npm run dev -w backend` and `npm run dev -w frontend`. Open
http://localhost:5173 — `/` is the public landing page and `/dashboard` the signed-in home page.

Production build:

```bash
npm run build
```

Then run `npm start -w backend` and serve `frontend/dist` from a web server that proxies `/api`,
`/media` and `/socket.io` to the backend (with `NODE_ENV=production`, HTTPS and a strong
`SESSION_SECRET`).

## REAL-TIME MULTIPLAYER — SETUP AND HOW TO PLAY

RUSH! already includes a complete real-time multiplayer game (waiting room, one global timer,
live play, reconnection, first-finisher winner and final standings) over Socket.IO. Nothing in
the game has to be built; this section only explains how to run it so **two players on two
computers on the same Wi-Fi** can play the same session.

### How it works (read this first)

The live game state lives **in memory inside a single backend process**. So only **one computer —
the host — runs the project (backend + frontend + MySQL)**, and **both players open the host's
address in their browser**. Two separate installations would be two independent games with two
separate databases and could not share a session.

Your teammate does **not** need to clone or run the project to play with you — they only need the
host's URL and their own account (they register at that URL). The GitHub download matters only if
they later want to host a game themselves.

```
Host computer                                         Teammate computer
┌───────────────────────────────┐                    ┌───────────────────────┐
│ MySQL (Docker)                 │                    │                       │
│ backend  (port 4000)           │  same Wi-Fi LAN    │ Browser               │
│ frontend (Vite, port 5173) ◄───┼────────────────────┤ http://<HOST-IP>:5173 │
│ Browser http://<HOST-IP>:5173  │                    │                       │
└───────────────────────────────┘                    └───────────────────────┘
```

Everything (REST API, `/socket.io` WebSocket and `/media`) is proxied through the single Vite port
**5173**, so only that one port has to be reachable from the other computer.

### 1. Required software (host only)

Node.js 20+, npm 10+ and Docker Desktop (for MySQL), as in [Prerequisites](#prerequisites). The
teammate only needs a web browser.

### 2–5. One-time setup on the host

```bash
npm install
cp .env.example .env     # Windows PowerShell: Copy-Item .env.example .env
npm run db:up            # start MySQL in Docker
npm run db:init          # create the schema
npm run db:seed          # OPTIONAL demo data (users ana/ben/cho, password rush-demo-1234)
```

Find the host's LAN IP address — **PowerShell:** `ipconfig` → read the **IPv4 Address** of your
Wi-Fi adapter (e.g. `192.168.1.42`). Then edit `.env` and set **both** URLs to that IP on port
5173, and set a translation provider so lookups do not error during the demo:

```ini
APP_URL=http://192.168.1.42:5173
PUBLIC_API_URL=http://192.168.1.42:5173
SESSION_SECRET=<a long random string>
TRANSLATION_PROVIDER=mock
```

> Why: `APP_URL` is the address written into invitation links and the allowed request origin;
> `PUBLIC_API_URL` is the base for media URLs and the allowed Socket.IO origin. Pointing both at
> `http://<HOST-IP>:5173` makes the invitation link open on the teammate's computer and lets the
> WebSocket connect. With the default `localhost` values the second computer cannot connect.

### 6. Start the servers on the host

```bash
npm run dev
```

This starts the backend on port 4000 and the Vite frontend on port 5173, bound to all network
interfaces (`host: true` in `frontend/vite.config.ts`) so the other computer can reach it.

Verify the backend is up and accepting connections (from the host):

```bash
curl http://localhost:4000/api/health          # -> {"ok":true}
```

From the **teammate's** computer, open `http://<HOST-IP>:5173` in a browser: the RUSH! landing
page should load. If it does, HTTP and WebSocket (same origin/port) both work.

### Windows Firewall and network

- Both computers must be on the **same Wi-Fi network** (and the network profile set to **Private**,
  not Public, or Windows blocks incoming connections).
- The first time `npm run dev` runs, Windows Defender Firewall usually shows **"Allow Node.js to
  communicate on these networks"** — tick **Private networks** and click **Allow access**.
- If no prompt appeared and the teammate cannot load the page, add an inbound rule for port 5173
  (run PowerShell **as Administrator** on the host):

  ```powershell
  New-NetFirewallRule -DisplayName "RUSH 5173" -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5173 -Profile Private
  ```

- Quick check from the teammate's machine: `ping <HOST-IP>` should succeed; if the browser still
  cannot connect, the firewall or a "Public" network profile is the usual cause.

### 7. Play — Player 1 (host)

1. Open `http://<HOST-IP>:5173` and **log in / register** with your own account.
2. You need a **published quiz with at least one question**. Either log in as a seeded user
   (`ana` / `rush-demo-1234`) who already has one, or go to **Quizzes → New quiz**, add a question,
   and press **Publish**.
3. Go to **Rooms → Create room** and open the new room.
4. In the room, **Add quiz** and pick your published quiz.
5. Open the **Invitations** tab → set an expiry → **Create**, then **Copy** the invitation link
   (it looks like `http://<HOST-IP>:5173/invite/<token>`). Send it to your teammate (WhatsApp,
   chat, email…).
6. Wait until your teammate appears in the room's **Members** list (the page refreshes itself).
7. On your quiz, press **Start session** — you are taken to the **Waiting room**.

### 8. Play — Player 2 (teammate)

1. Open the invitation link your teammate sent, in a browser on the other computer.
2. If not signed in, you are sent to the login page — **register your own account** (or log in),
   and you are returned to the invitation automatically.
3. Accept the invitation to **join the room**.
4. When the host starts the session, open the room and click **Open session** (a banner appears
   while the session is waiting), which takes you to the same **Waiting room**.

### 9–11. Start and play

With both players in the waiting room, the host presses **Start game**. Both players answer at
their own pace; the first to finish every question wins and ends the game for everyone, or time
runs out. Both then see the winner and the final standings; each player's own answers are on the
results page. If a browser briefly loses Wi-Fi, it reconnects and resumes at the same question
with the remaining global time.

### 12. Troubleshooting

| Problem | Fix |
|---|---|
| Teammate's browser cannot open `http://<HOST-IP>:5173` | Same Wi-Fi? Network profile **Private**? Firewall rule for 5173 added? `ipconfig` IP still correct (it can change)? |
| Page loads but actions fail with "Cross-origin request blocked" | `APP_URL`/`PUBLIC_API_URL` in the host `.env` are not `http://<HOST-IP>:5173`, or the host is using the `localhost` URL instead of the IP. Both players must use the **same** `http://<HOST-IP>:5173` address. Restart `npm run dev` after editing `.env`. |
| Invitation link points at `localhost` | `APP_URL` was not changed to the host IP before the link was created. Fix `.env`, restart, create a new link. |
| "This invitation link has expired" / wrong user | Create a new link; a link addressed to a specific user only works for that account. |
| Translation popup says "not configured" | Set `TRANSLATION_PROVIDER=mock` in `.env` and restart. |
| Everyone logged out / game cancelled after restarting the backend | Expected: sessions and timers are in memory (a single backend process is assumed). Start a new session. |

## Tests

| Command | Scope |
|---|---|
| `npm run typecheck` | TypeScript checks for all workspaces |
| `npm test` | Unit and integration tests: shared (15), backend (75, against `DB_TEST_NAME`, created automatically) and frontend (12) |
| `npm run test:e2e` | Playwright end-to-end tests (8): landing page, authentication, a complete two-player live game (global timer, first finisher wins), translation and vocabulary, the English-only interface, and the presentation-version restrictions |

The end-to-end tests start their own backend (port 4100) and frontend (port 5174) and reset a
disposable database whose name must end in `_e2e` (default `rush_e2e`). For this installation:

```bash
DB_E2E_NAME=rush_presentation_e2e PW_CHANNEL=chrome npm run test:e2e
```

`PW_CHANNEL=chrome` uses the installed Google Chrome; without it, run `npx playwright install chromium`
once in `frontend/`. The backend tests and `npm run db:init` require a MySQL user allowed to create
databases. `generator/test_schema.sh` contains behavioural tests of the schema itself.

## API overview

All endpoints are under `/api`, exchange JSON and require a session unless noted. Errors have the
form `{ "error": { "code", "message", "details?" } }`. State-changing requests must come from the
application's origin.

| Area | Endpoints |
|---|---|
| Auth and profile | `POST /auth/register`, `POST /auth/login`, `POST /auth/logout`, `GET /auth/me`, `PATCH /me/profile`, `PATCH /me/preferences`, `POST /me/password`, `DELETE /me`, `GET /users/:username` |
| Rooms | `GET/POST /rooms`, `GET/PATCH/DELETE /rooms/:roomId`, `POST /rooms/:roomId/leave`, `PATCH/DELETE /rooms/:roomId/members/:userId` |
| Room quizzes | `POST /rooms/:roomId/quizzes`, `POST /rooms/:roomId/quizzes/new`, `DELETE /rooms/:roomId/quizzes/:quizId` |
| Invitations | `GET/POST /rooms/:roomId/invitations`, `DELETE /rooms/:roomId/invitations/:id`, `GET /invitations/:token`, `POST /invitations/:token/accept` |
| Topics | `GET/POST /topics`, `DELETE /topics/:topicId`, `GET/POST /admin/topics`, `PATCH/DELETE /admin/topics/:id` (SUPERADMIN) |
| Quizzes | `GET /quizzes`, `GET /quizzes/editable`, `POST /quizzes`, `GET/PATCH/DELETE /quizzes/:quizId`, `POST /quizzes/:quizId/status`, `POST /quizzes/:quizId/collaborators`, `DELETE /quizzes/:quizId/collaborators/:userId` |
| Questions | `POST /quizzes/:quizId/questions`, `PUT/DELETE /questions/:questionId`, `POST /questions/:questionId/move` |
| Media | `POST /media` (multipart `file`) |
| Sessions | `POST/GET /rooms/:roomId/sessions`, `GET /sessions/mine`, `GET /sessions/:id`, `GET /sessions/:id/results`, `POST /sessions/:id/cancel` |
| Translation | `POST /translate`, `GET /translate/:translationId/explanation` |
| Vocabulary | `GET/POST /vocabulary`, `PATCH/DELETE /vocabulary/:savedWordId`, `GET /vocabulary/export` |

Real-time events (Socket.IO): the client emits `session:join`, `session:start`, `session:cancel`,
`session:answer` and `session:leave`; the server emits `session:lobby`, `session:started` (global
deadline), `session:timer` (deadline re-broadcast every 5 s), `session:question` (each player's
next question), `session:question-end` (that player's result), `session:completed` (end reason,
winner and standings), `session:cancelled` and `session:removed`.

## Limitations

* **Presentation restrictions are applied in the user interface.** The backend still accepts every
  question type, audio and MP4 video uploads (≤ 720p), vocabulary export and room cover URLs when
  called directly.
* Login sessions and live-game timers are kept in memory: restarting the backend logs users out and
  cancels running games. A single backend process is assumed.
* A running game continues until someone finishes or the global time expires, even if every player
  disconnects (they can rejoin); the host can cancel it from the room.
* The three columns added for the global timer and the winner (`quiz.total_time_limit_seconds`,
  `quiz_session.winner_user_id`, `quiz_attempt.finished_at`) were added directly to
  `database/rush_schema.sql`; `generator/generate_rush_model.py` and `database/RUSH_ERD.mdj` do not
  include them yet. `question.time_limit_seconds` is kept for existing data but no longer used.
* Questions cannot be reordered while a quiz has exactly 25 questions.
* Deleting a quiz or a room also deletes its session history.
* Translation needs `GOOGLE_TRANSLATE_API_KEY` (or `TRANSLATION_PROVIDER=mock`); explanations need
  `OPENAI_API_KEY`. Email needs an SMTP server; otherwise messages are printed to the console.
* The landing page describes the full application (for example "five question types").

## Troubleshooting

| Problem | Fix |
|---|---|
| `Cannot connect to MySQL` | Start MySQL (`npm run db:up` or `docker start rush-mysql-dev`) and check `DB_PORT`. |
| `Database "…" has no RUSH schema` | Run `npm run db:init`. |
| `Invalid configuration (.env)` | Create `.env` at the project root with a `SESSION_SECRET` of at least 16 characters. |
| Port 4000, 5173 or 3307 in use | Stop the other process (for example another RUSH! checkout) or change `PORT` / `DB_PORT`. |
| Translation popup reports "not configured" | Set `GOOGLE_TRANSLATE_API_KEY` or `TRANSLATION_PROVIDER=mock` and restart the backend. |
| E2E: `Executable doesn't exist` | Use `PW_CHANNEL=chrome` or run `npx playwright install chromium` in `frontend/`. |

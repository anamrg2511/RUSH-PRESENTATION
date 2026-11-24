/** Business limits from the RUSH! requirements and docs/OPEN_QUESTIONS.md. */
export const LIMITS = {
  maxRoomsPerUser: 10,
  maxMembersPerRoom: 40, // including the owner
  maxQuizzesPerUser: 15,
  maxQuestionsPerQuiz: 25,
  maxOptionsPerQuestion: 10,
  minOptionsMultipleChoice: 2,
  minMatchingPairs: 2,
  maxMatchingPairs: 10, // A-11
  maxMediaPerQuestion: 1, // A-12
  minPoints: 1,
  maxPoints: 1000, // A-14
  defaultPoints: 100,
  // One global time limit for the whole quiz in a live session (A-14, A-20).
  minQuizTimeLimitSeconds: 60,
  maxQuizTimeLimitSeconds: 3600,
  defaultQuizTimeLimitSeconds: 300,
  invitationTtlHours: 1, // A-4: invitation links are valid for exactly one hour (server-enforced)
  maxVideoHeight: 720,
  maxVideoWidth: 1280,
  maxImageBytes: 5 * 1024 * 1024,
  maxAudioBytes: 10 * 1024 * 1024,
  maxVideoBytes: 50 * 1024 * 1024,
  maxWordLength: 100,
  answerRevealMs: 1500, // how long a player sees their own result before their next question (A-20)
  timerSyncMs: 5000, // the server re-broadcasts the global deadline this often
} as const;

export const LANGUAGES = ['ENGLISH', 'KOREAN'] as const;
export type Language = (typeof LANGUAGES)[number];

export const QUESTION_TYPES = [
  'MULTIPLE_CHOICE',
  'TRUE_FALSE',
  'OPEN_ANSWER',
  'FILL_IN_THE_BLANK',
  'MATCHING',
] as const;
export type QuestionType = (typeof QUESTION_TYPES)[number];

export const MEDIA_TYPES = ['IMAGE', 'AUDIO', 'VIDEO'] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const MEMBERSHIP_ROLES = ['OWNER', 'ADMIN', 'MEMBER'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

export const SESSION_STATUSES = ['WAITING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

/** Blank marker for FILL_IN_THE_BLANK questions (A-29): three or more underscores. */
export const BLANK_MARKER_REGEX = /_{3,}/g;

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Define las constantes y enumeraciones de negocio usadas por frontend y backend.

Responsabilidades principales:
- LIMITS: 10 salas por usuario, 40 miembros, 15 cuestionarios, 25 preguntas, 10 opciones, 2–10
  pares, 1 medio por pregunta, puntos 1–1000, tiempo global del cuestionario de 1 a 60 minutos
  (5 por defecto), invitaciones de 1 a 720 horas, tamaños de archivo, 720p, 1,5 s de revelación y
  sincronización del temporizador cada 5 s.
- Listas de valores: LANGUAGES, QUESTION_TYPES, MEDIA_TYPES, MEMBERSHIP_ROLES, SESSION_STATUSES.
- BLANK_MARKER_REGEX: hueco "___" de las preguntas de completar.

Elementos importantes:
- LIMITS
- LANGUAGES / Language
- QUESTION_TYPES / QuestionType
- MEDIA_TYPES / MediaType
- MEMBERSHIP_ROLES / MembershipRole
- SESSION_STATUSES / SessionStatus
- BLANK_MARKER_REGEX

Dependencias:
- Ninguna

Flujo de datos:
Valores de solo lectura consultados por validaciones, servicios y pantallas.

Aspectos técnicos importantes:
- Los valores coinciden con las restricciones ENUM y CHECK de rush_schema.sql.

Lugar en la arquitectura:
Capa compartida. Fuente única de los límites del sistema.
*/

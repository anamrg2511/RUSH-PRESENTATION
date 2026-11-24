import type { Language, MediaType, MembershipRole, QuestionType, SessionStatus } from './limits';

/** API response shapes shared by the backend and the frontend. Dates are ISO strings. */

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

export interface MeDto {
  userId: number;
  fullName: string;
  username: string;
  email: string;
  profilePictureUrl: string | null;
  description: string | null;
  learningLanguage: Language | null;
  accountRole: 'USER' | 'SUPERADMIN';
  createdAt: string;
  preferences: { interfaceLanguage: Language; translationTargetLanguage: Language };
}

export interface PublicUserDto {
  userId: number;
  fullName: string;
  username: string;
  profilePictureUrl: string | null;
  description: string | null;
  learningLanguage: Language | null;
}

export interface TopicDto {
  topicId: number;
  name: string;
  topicType: 'PREDEFINED' | 'CUSTOM';
  createdByUserId: number | null;
}

export interface RoomSummaryDto {
  roomId: number;
  name: string;
  description: string;
  coverImageUrl: string;
  ownerUserId: number;
  myRole: MembershipRole;
  memberCount: number;
  quizCount: number;
  topics: TopicDto[];
  hasActiveSession: boolean;
}

export interface RoomMemberDto {
  userId: number;
  username: string;
  fullName: string;
  profilePictureUrl: string | null;
  role: MembershipRole;
  joinedAt: string;
}

export interface RoomQuizDto {
  quizId: number;
  title: string;
  description: string;
  status: 'DRAFT' | 'PUBLISHED';
  questionCount: number;
  creatorUsername: string;
  addedAt: string;
  canEdit: boolean;
}

export interface ActiveSessionDto {
  sessionId: number;
  quizId: number;
  quizTitle: string;
  status: SessionStatus;
  hostUsername: string | null;
}

export interface RoomDetailDto extends RoomSummaryDto {
  createdAt: string;
  members: RoomMemberDto[];
  quizzes: RoomQuizDto[];
  activeSession: ActiveSessionDto | null;
}

export interface InvitationDto {
  invitationId: number;
  expiresAt: string;
  createdAt: string;
  createdByUsername: string;
  invitedUsername: string | null;
  expired: boolean;
}

export interface CreatedInvitationDto extends InvitationDto {
  /** Shown once: only the hash is stored. */
  url: string;
  token: string;
}

export interface InvitationPreviewDto {
  roomId: number;
  roomName: string;
  roomDescription: string;
  coverImageUrl: string;
  memberCount: number;
  expiresAt: string;
  alreadyMember: boolean;
}

export interface QuizSummaryDto {
  quizId: number;
  title: string;
  description: string;
  status: 'DRAFT' | 'PUBLISHED';
  isInLibrary: boolean;
  creatorUserId: number;
  creatorUsername: string;
  isOwner: boolean;
  questionCount: number;
  /** global time limit for the whole quiz in a live session */
  totalTimeLimitSeconds: number;
  createdAt: string;
  updatedAt: string;
}

export interface MediaDto {
  mediaId: number;
  mediaType: MediaType;
  mediaUrl: string;
}

export interface QuestionDto {
  questionId: number;
  questionText: string;
  questionType: QuestionType;
  pointValue: number;
  displayOrder: number;
  correctTextAnswer: string | null;
  options: { optionId: number; text: string; isCorrect: boolean; displayOrder: number }[];
  pairs: { pairId: number; left: string; right: string; displayOrder: number }[];
  media: MediaDto | null;
  /** true when answers were recorded for this question: it is locked (A-7) */
  locked: boolean;
}

export interface QuizDetailDto extends QuizSummaryDto {
  questions: QuestionDto[];
  collaborators: PublicUserDto[];
  rooms: { roomId: number; name: string }[];
}

/**
 * A player's current question during a session — never contains correct answers. Each player
 * advances at their own pace; endsAt is the ONE global deadline of the session (it never resets).
 */
export interface LiveQuestionDto {
  questionId: number;
  index: number; // 0-based, this player's position
  total: number;
  questionText: string;
  questionType: QuestionType;
  pointValue: number;
  media: { mediaType: MediaType; mediaUrl: string } | null;
  options: { optionId: number; text: string }[];
  matchingLeft: { pairId: number; text: string }[];
  matchingRight: { pairId: number; text: string }[]; // shuffled
  /** global deadline of the session, epoch ms (server clock) */
  endsAt: number;
  serverNow: number;
  /** total time configured for the quiz */
  totalTimeLimitSeconds: number;
}
/** Periodic re-broadcast of the global deadline so every client stays in sync. */
export interface TimerSyncDto {
  endsAt: number;
  serverNow: number;
  totalTimeLimitSeconds: number;
}

export interface LobbyStateDto {
  sessionId: number;
  roomId: number;
  quizTitle: string;
  questionCount: number;
  /** global time limit for the whole quiz */
  totalTimeLimitSeconds: number;
  status: SessionStatus;
  hostUserId: number | null;
  participants: { userId: number; username: string; fullName: string; profilePictureUrl: string | null }[];
  canControl: boolean;
}

export interface QuestionEndDto {
  questionId: number;
  answered: boolean;
  isCorrect: boolean;
  pointsEarned: number;
  correctAnswer: string; // human-readable
}

export interface StandingDto {
  userId: number;
  username: string;
  fullName: string;
  totalScore: number;
  disconnected: boolean;
  /** answered every question */
  finished: boolean;
  /** the participant with the highest final score (ties broken by earliest completion) */
  isWinner: boolean;
}
export interface WinnerDto {
  userId: number;
  username: string;
  fullName: string;
}
/**
 * Why a session ended: 'completed' = every participant answered all questions before the deadline;
 * 'time_up' = the global time limit expired first. The winner is the highest final score either way.
 */
export type GameEndReason = 'completed' | 'time_up';
/** Sent to everybody when the game ends. */
export interface GameEndDto {
  sessionId: number;
  reason: GameEndReason;
  winner: WinnerDto | null;
  standings: StandingDto[];
}

export interface SessionResultDto {
  sessionId: number;
  roomId: number;
  roomName: string;
  quizId: number;
  quizTitle: string;
  status: SessionStatus;
  startedAt: string | null;
  endedAt: string | null;
  /** null for cancelled or unfinished sessions */
  endReason: GameEndReason | null;
  winner: WinnerDto | null;
  standings: StandingDto[];
  /** the requesting user's own answers; null when they did not take part */
  myAnswers:
    | {
        questionId: number;
        displayOrder: number;
        questionText: string;
        questionType: QuestionType;
        pointValue: number;
        yourAnswer: string;
        correctAnswer: string;
        isCorrect: boolean;
        pointsEarned: number;
      }[]
    | null;
  myTotalScore: number | null;
  maxScore: number;
}

export interface SessionHistoryItemDto {
  sessionId: number;
  roomId: number;
  roomName: string;
  quizTitle: string;
  status: SessionStatus;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  participantCount: number;
  myScore: number | null;
}

export interface TranslationDto {
  translationId: number;
  sourceWord: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  translatedWord: string;
  contextualExplanation: string | null;
  cached: boolean;
  savedWordId: number | null;
}

export interface SavedWordDto {
  savedWordId: number;
  translationId: number;
  sourceWord: string;
  sourceLanguage: Language;
  targetLanguage: Language;
  translatedWord: string;
  contextualExplanation: string | null;
  personalNote: string | null;
  isFavorite: boolean;
  savedAt: string;
  lastLookedUpAt: string;
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Tipos de los objetos que intercambian backend y frontend (DTO: Data Transfer Objects).

Responsabilidades principales:
- MeDto, PublicUserDto, RoomSummaryDto, RoomDetailDto, InvitationDto, QuizDetailDto, QuestionDto,
  LiveQuestionDto (sin respuestas correctas, con la fecha límite global endsAt), TimerSyncDto,
  LobbyStateDto, QuestionEndDto, StandingDto (finished, isWinner), WinnerDto, GameEndDto (motivo de
  fin, ganador y clasificación), SessionResultDto, TranslationDto, SavedWordDto, entre otros.

Elementos importantes:
- interfaces *Dto
- ApiErrorBody

Dependencias:
- shared/src/limits.ts

Flujo de datos:
Describen el JSON de las respuestas de la API y de los eventos Socket.IO.

Aspectos técnicos importantes:
- Las fechas viajan como cadenas ISO.

Lugar en la arquitectura:
Capa compartida. Contrato de datos entre cliente y servidor.
*/

import type {
  CreatedInvitationDto,
  InvitationDto,
  InvitationPreviewDto,
  Language,
  MeDto,
  MediaType,
  PublicUserDto,
  QuestionInputRaw,
  QuizDetailDto,
  QuizSummaryDto,
  RoomDetailDto,
  RoomSummaryDto,
  SavedWordDto,
  SessionHistoryItemDto,
  SessionResultDto,
  SessionStatus,
  TopicDto,
  TranslationDto,
} from '@rush/shared';
import { api, del, get, patch, post, put } from './client';

export interface SessionInfoDto {
  sessionId: number;
  roomId: number;
  roomName: string;
  quizId: number;
  quizTitle: string;
  status: SessionStatus;
  hostUserId: number | null;
  canControl: boolean;
}

export const authApi = {
  me: () => get<MeDto>('/auth/me'),
  login: (identifier: string, password: string) => post<MeDto>('/auth/login', { identifier, password }),
  register: (body: { fullName: string; username: string; email: string; password: string }) => post<MeDto>('/auth/register', body),
  logout: () => post<void>('/auth/logout'),
  updateProfile: (body: Partial<{ fullName: string; username: string; profilePictureUrl: string | null; description: string | null; learningLanguage: Language | null }>) =>
    patch<MeDto>('/me/profile', body),
  updatePreferences: (body: { translationTargetLanguage: Language }) => patch<MeDto>('/me/preferences', body),
  changePassword: (currentPassword: string, newPassword: string) => post<void>('/me/password', { currentPassword, newPassword }),
  deleteAccount: (password: string) => del('/me', { password }),
  profile: (username: string) => get<PublicUserDto>(`/users/${encodeURIComponent(username)}`),
};

export const roomsApi = {
  list: () => get<RoomSummaryDto[]>('/rooms'),
  get: (roomId: number) => get<RoomDetailDto>(`/rooms/${roomId}`),
  create: (body: { name: string; description: string; coverImageUrl: string | null; topicIds: number[] }) => post<RoomDetailDto>('/rooms', body),
  update: (roomId: number, body: Partial<{ name: string; description: string; coverImageUrl: string | null; topicIds: number[] }>) =>
    patch<RoomDetailDto>(`/rooms/${roomId}`, body),
  remove: (roomId: number) => del(`/rooms/${roomId}`),
  leave: (roomId: number) => post<void>(`/rooms/${roomId}/leave`),
  removeMember: (roomId: number, userId: number) => del(`/rooms/${roomId}/members/${userId}`),
  setRole: (roomId: number, userId: number, role: 'ADMIN' | 'MEMBER') => patch<void>(`/rooms/${roomId}/members/${userId}`, { role }),
  addQuiz: (roomId: number, quizId: number) => post<void>(`/rooms/${roomId}/quizzes`, { quizId }),
  createQuizInRoom: (roomId: number, body: { title: string; description: string }) => post<{ quizId: number }>(`/rooms/${roomId}/quizzes/new`, body),
  removeQuiz: (roomId: number, quizId: number) => del(`/rooms/${roomId}/quizzes/${quizId}`),
  invitations: (roomId: number) => get<InvitationDto[]>(`/rooms/${roomId}/invitations`),
  createInvitation: (roomId: number, body: { invitee?: string }) => post<CreatedInvitationDto>(`/rooms/${roomId}/invitations`, body),
  revokeInvitation: (roomId: number, invitationId: number) => del(`/rooms/${roomId}/invitations/${invitationId}`),
  sessions: (roomId: number) => get<SessionHistoryItemDto[]>(`/rooms/${roomId}/sessions`),
  startSession: (roomId: number, quizId: number) => post<{ sessionId: number }>(`/rooms/${roomId}/sessions`, { quizId }),
};

export const invitationsApi = {
  preview: (token: string) => get<InvitationPreviewDto>(`/invitations/${encodeURIComponent(token)}`),
  accept: (token: string) => post<{ roomId: number; status: 'added' | 'already_member' }>(`/invitations/${encodeURIComponent(token)}/accept`),
};

export const topicsApi = {
  list: () => get<TopicDto[]>('/topics'),
  createCustom: (name: string) => post<TopicDto>('/topics', { name }),
  removeCustom: (topicId: number) => del(`/topics/${topicId}`),
  adminList: () => get<TopicDto[]>('/admin/topics'),
  adminCreate: (name: string) => post<TopicDto>('/admin/topics', { name }),
  adminRename: (topicId: number, name: string) => patch<void>(`/admin/topics/${topicId}`, { name }),
  adminRemove: (topicId: number) => del(`/admin/topics/${topicId}`),
};

export const quizzesApi = {
  library: () => get<{ owned: QuizSummaryDto[]; shared: QuizSummaryDto[]; ownedTotal: number }>('/quizzes'),
  editable: () => get<QuizSummaryDto[]>('/quizzes/editable'),
  create: (body: { title: string; description: string }) => post<QuizDetailDto>('/quizzes', body),
  get: (quizId: number) => get<QuizDetailDto>(`/quizzes/${quizId}`),
  update: (quizId: number, body: Partial<{ title: string; description: string; totalTimeLimitSeconds: number }>) => patch<QuizDetailDto>(`/quizzes/${quizId}`, body),
  setStatus: (quizId: number, status: 'DRAFT' | 'PUBLISHED') => post<QuizDetailDto>(`/quizzes/${quizId}/status`, { status }),
  remove: (quizId: number) => del(`/quizzes/${quizId}`),
  addCollaborator: (quizId: number, username: string) => post<QuizDetailDto>(`/quizzes/${quizId}/collaborators`, { username }),
  removeCollaborator: (quizId: number, userId: number) => del(`/quizzes/${quizId}/collaborators/${userId}`),
  addQuestion: (quizId: number, body: QuestionInputRaw) => post<{ questionId: number }>(`/quizzes/${quizId}/questions`, body),
  updateQuestion: (questionId: number, body: QuestionInputRaw) => put<void>(`/questions/${questionId}`, body),
  deleteQuestion: (questionId: number) => del(`/questions/${questionId}`),
  moveQuestion: (questionId: number, displayOrder: number) => post<void>(`/questions/${questionId}/move`, { displayOrder }),
};

export const mediaApi = {
  upload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return api<{ mediaType: MediaType; mediaUrl: string }>('POST', '/media', fd);
  },
};

export const sessionsApi = {
  info: (sessionId: number) => get<SessionInfoDto>(`/sessions/${sessionId}`),
  results: (sessionId: number) => get<SessionResultDto>(`/sessions/${sessionId}/results`),
  mine: () => get<SessionHistoryItemDto[]>('/sessions/mine'),
  cancel: (sessionId: number) => post<void>(`/sessions/${sessionId}/cancel`),
};

export const translationApi = {
  translate: (word: string) => post<TranslationDto>('/translate', { word }),
  explanation: (translationId: number) => get<{ translationId: number; contextualExplanation: string }>(`/translate/${translationId}/explanation`),
};

export const vocabularyApi = {
  list: (q: string, favorites: boolean) => get<SavedWordDto[]>(`/vocabulary?q=${encodeURIComponent(q)}${favorites ? '&favorites=1' : ''}`),
  save: (translationId: number, personalNote?: string) => post<SavedWordDto>('/vocabulary', { translationId, personalNote }),
  update: (savedWordId: number, body: Partial<{ personalNote: string | null; isFavorite: boolean }>) => patch<SavedWordDto>(`/vocabulary/${savedWordId}`, body),
  remove: (savedWordId: number) => del(`/vocabulary/${savedWordId}`),
  exportUrl: (format: 'csv' | 'json') => `/api/vocabulary/export?format=${format}`,
};

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Declara una función por cada endpoint del backend, agrupadas por área, con los tipos de
entrada y salida.

Responsabilidades principales:
- authApi (registro, sesión, perfil, contraseña, cuenta).
- roomsApi (salas, miembros, invitaciones, sesiones).
- invitationsApi, topicsApi, quizzesApi, mediaApi, sessionsApi, translationApi y vocabularyApi.

Elementos importantes:
- authApi
- roomsApi
- invitationsApi
- topicsApi
- quizzesApi
- mediaApi
- sessionsApi
- translationApi
- vocabularyApi
- interface SessionInfoDto

Dependencias:
- api/client.ts
- @rush/shared (tipos DTO)

Flujo de datos:
Los componentes llaman a estas funciones, normalmente a través de useQuery o en manejadores de
eventos.

Aspectos técnicos importantes:
- vocabularyApi.exportUrl sigue declarado aunque la versión de presentación no muestra el botón de
  exportación.

Lugar en la arquitectura:
Capa de comunicación del frontend. Documenta en código el contrato entre frontend y backend.
*/

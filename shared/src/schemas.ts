import { z } from 'zod';
import { LANGUAGES, LIMITS } from './limits';

const trimmed = (min: number, max: number) => z.string().trim().min(min).max(max);
const language = z.enum(LANGUAGES);

/** Absolute http(s) URL or empty → null. */
export const optionalUrl = z
  .union([z.string().trim().url().max(2048).refine((u) => /^https?:\/\//i.test(u), 'http_url_required'), z.literal(''), z.null()])
  .transform((v) => (v ? v : null));

export const usernameSchema = z
  .string()
  .trim()
  .min(3)
  .max(30)
  .regex(/^[A-Za-z0-9_.]+$/, 'username_chars');

export const passwordSchema = z.string().min(8, 'password_too_short').max(128);

export const registerSchema = z.object({
  fullName: trimmed(1, 100),
  username: usernameSchema,
  email: z.string().trim().toLowerCase().email().max(255),
  password: passwordSchema,
});

export const loginSchema = z.object({
  identifier: trimmed(1, 255), // username or email
  password: z.string().min(1).max(128),
});

export const updateProfileSchema = z
  .object({
    fullName: trimmed(1, 100),
    username: usernameSchema,
    profilePictureUrl: optionalUrl,
    description: z.union([z.string().trim().max(2000), z.null()]).transform((v) => (v ? v : null)),
    learningLanguage: language.nullable(),
  })
  .partial()
  .strict(); // email is not accepted: it is immutable

export const updatePreferencesSchema = z
  .object({ interfaceLanguage: language, translationTargetLanguage: language })
  .partial()
  .strict();

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: passwordSchema,
});

export const deleteAccountSchema = z.object({ password: z.string().min(1).max(128) });

export const roomInputSchema = z.object({
  name: trimmed(1, 100),
  description: z.string().trim().max(5000).default(''),
  coverImageUrl: optionalUrl.default(null),
  topicIds: z.array(z.number().int().positive()).max(20).default([]),
});
export const roomUpdateSchema = roomInputSchema.partial();

export const invitationCreateSchema = z.object({
  // The validity period is fixed at one hour and set server-side; clients cannot choose or extend it.
  /** username or email of a registered user; omitted for an open link */
  invitee: z.string().trim().min(1).max(255).optional(),
});

export const memberRoleSchema = z.object({ role: z.enum(['ADMIN', 'MEMBER']) });

export const topicInputSchema = z.object({ name: trimmed(1, 50) });

export const quizInputSchema = z.object({
  title: trimmed(1, 150),
  description: z.string().trim().max(5000).default(''),
  /** One global time limit for the whole quiz (seconds). */
  totalTimeLimitSeconds: z
    .number()
    .int()
    .min(LIMITS.minQuizTimeLimitSeconds)
    .max(LIMITS.maxQuizTimeLimitSeconds)
    .default(LIMITS.defaultQuizTimeLimitSeconds),
});
export const quizUpdateSchema = quizInputSchema.partial();
export const quizStatusSchema = z.object({ status: z.enum(['DRAFT', 'PUBLISHED']) });
export const collaboratorSchema = z.object({ username: usernameSchema });
export const roomQuizSchema = z.object({ quizId: z.number().int().positive() });
export const moveQuestionSchema = z.object({ displayOrder: z.number().int().min(1).max(LIMITS.maxQuestionsPerQuiz) });

export const createSessionSchema = z.object({ quizId: z.number().int().positive() });

/** A single word: letters (any script) with optional inner apostrophes/hyphens. No spaces. */
export const wordSchema = z
  .string()
  .trim()
  .min(1)
  .max(LIMITS.maxWordLength)
  .regex(/^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$/u, 'single_word_only');

export const translateSchema = z.object({ word: wordSchema });

export const saveWordSchema = z.object({
  translationId: z.number().int().positive(),
  personalNote: z.string().trim().max(2000).optional(),
});
export const updateSavedWordSchema = z
  .object({
    personalNote: z.union([z.string().trim().max(2000), z.null()]).transform((v) => (v ? v : null)),
    isFavorite: z.boolean(),
  })
  .partial()
  .strict();

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Esquemas Zod para el resto de entradas: registro, inicio de sesión, perfil, contraseña,
salas, invitaciones, temas, cuestionarios, sesiones, traducción y vocabulario.

Responsabilidades principales:
- usernameSchema (3–30 caracteres alfanuméricos, punto o guion bajo) y passwordSchema (mínimo 8).
- updateProfileSchema en modo strict: no acepta el campo email.
- roomInputSchema, invitationCreateSchema, quizInputSchema, wordSchema (una sola palabra),
  saveWordSchema y otros.
- quizInputSchema incluye totalTimeLimitSeconds: el tiempo límite global del cuestionario
  (60–3600 s, 300 por defecto).

Elementos importantes:
- optionalUrl
- usernameSchema
- passwordSchema
- registerSchema
- loginSchema
- updateProfileSchema
- updatePreferencesSchema
- changePasswordSchema
- deleteAccountSchema
- roomInputSchema
- roomUpdateSchema
- invitationCreateSchema
- memberRoleSchema
- topicInputSchema
- quizInputSchema
- quizUpdateSchema
- quizStatusSchema
- collaboratorSchema
- roomQuizSchema
- moveQuestionSchema
- createSessionSchema
- wordSchema
- translateSchema
- saveWordSchema
- updateSavedWordSchema

Dependencias:
- zod
- shared/src/limits.ts

Flujo de datos:
Las rutas del backend validan con parse(schema, req.body); algunos formularios del frontend validan
antes de enviar.

Aspectos técnicos importantes:
- El correo se convierte a minúsculas al registrarse.

Lugar en la arquitectura:
Capa compartida. Define el formato válido de cada petición.
*/

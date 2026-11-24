import crypto from 'node:crypto';
import type { CreatedInvitationDto, InvitationDto, InvitationPreviewDto } from '@rush/shared';
import { LIMITS } from '@rush/shared';
import type { invitationCreateSchema } from '@rush/shared';
import type { z } from 'zod';
import { env } from '../config/env';
import { db, transaction } from '../db';
import { AppError, badRequest, conflict, forbidden, notFound } from '../http/errors';
import { emails } from '../integrations/mailer';
import { requireRoomManager } from './permissions';
import { addMemberLocked } from './rooms';
import { findUserIdByIdentifier } from './users';

/** Only the SHA-256 hash of the token is stored; the raw token exists only in the link. */
export const hashToken = (token: string) => crypto.createHash('sha256').update(token, 'utf8').digest('hex');
const newToken = () => crypto.randomBytes(32).toString('base64url');
const isTokenShaped = (token: string) => /^[A-Za-z0-9_-]{20,100}$/.test(token);
const inviteUrl = (token: string) => `${env.APP_URL.replace(/\/$/, '')}/invite/${token}`;

const expiredError = () => new AppError(410, 'invitation_expired', 'This invitation link has expired');

export async function createInvitation(
  roomId: number,
  userId: number,
  input: z.infer<typeof invitationCreateSchema>,
): Promise<CreatedInvitationDto> {
  await requireRoomManager(roomId, userId);
  const room = await db.selectFrom('room').select('name').where('room_id', '=', roomId).executeTakeFirstOrThrow();
  const creator = await db.selectFrom('user').select('username').where('user_id', '=', userId).executeTakeFirstOrThrow();

  let invited: Awaited<ReturnType<typeof findUserIdByIdentifier>> = null;
  if (input.invitee) {
    invited = await findUserIdByIdentifier(input.invitee);
    if (!invited) throw notFound('User');
    if (invited.userId === userId) throw badRequest('cannot_invite_self', 'You are already in this room');
    const member = await db
      .selectFrom('room_membership')
      .select('user_id')
      .where('room_id', '=', roomId)
      .where('user_id', '=', invited.userId)
      .executeTakeFirst();
    if (member) throw conflict('already_member', 'This user is already a member');
  }

  const token = newToken();
  const now = new Date();
  now.setMilliseconds(0);
  // Expiry is fixed at one hour from the server-side creation time; the client cannot influence it.
  const expiresAt = new Date(now.getTime() + LIMITS.invitationTtlHours * 3600_000);
  const res = await db
    .insertInto('room_invitation')
    .values({
      room_id: roomId,
      created_by_user_id: userId,
      invited_user_id: invited?.userId ?? null,
      token_hash: hashToken(token),
      expires_at: expiresAt,
      created_at: now,
    })
    .executeTakeFirstOrThrow();

  const url = inviteUrl(token);
  if (invited) emails.roomInvitation(invited.email, creator.username, room.name, url, expiresAt);

  return {
    invitationId: Number(res.insertId),
    expiresAt: expiresAt.toISOString(),
    createdAt: now.toISOString(),
    createdByUsername: creator.username,
    invitedUsername: invited?.username ?? null,
    expired: false,
    url,
    token,
  };
}

export async function listInvitations(roomId: number, userId: number): Promise<InvitationDto[]> {
  await requireRoomManager(roomId, userId);
  const rows = await db
    .selectFrom('room_invitation as i')
    .innerJoin('user as c', 'c.user_id', 'i.created_by_user_id')
    .leftJoin('user as t', 't.user_id', 'i.invited_user_id')
    .select(['i.invitation_id', 'i.expires_at', 'i.created_at', 'c.username as creator', 't.username as invited'])
    .where('i.room_id', '=', roomId)
    .orderBy('i.created_at', 'desc')
    .execute();
  const now = Date.now();
  return rows.map((r) => ({
    invitationId: r.invitation_id,
    expiresAt: r.expires_at.toISOString(),
    createdAt: r.created_at.toISOString(),
    createdByUsername: r.creator,
    invitedUsername: r.invited,
    expired: r.expires_at.getTime() <= now,
  }));
}

export async function revokeInvitation(roomId: number, invitationId: number, userId: number): Promise<void> {
  await requireRoomManager(roomId, userId);
  const res = await db
    .deleteFrom('room_invitation')
    .where('room_id', '=', roomId)
    .where('invitation_id', '=', invitationId)
    .executeTakeFirst();
  if (Number(res.numDeletedRows) === 0) throw notFound('Invitation');
}

async function findValidInvitation(token: string, userId: number) {
  if (!isTokenShaped(token)) throw notFound('Invitation');
  const inv = await db
    .selectFrom('room_invitation')
    .selectAll()
    .where('token_hash', '=', hashToken(token))
    .executeTakeFirst();
  if (!inv) throw notFound('Invitation');
  if (inv.expires_at.getTime() <= Date.now()) throw expiredError();
  if (inv.invited_user_id !== null && inv.invited_user_id !== userId) {
    throw forbidden('This invitation was sent to another user');
  }
  return inv;
}

export async function previewInvitation(token: string, userId: number): Promise<InvitationPreviewDto> {
  const inv = await findValidInvitation(token, userId);
  const room = await db
    .selectFrom('room as r')
    .select((eb) => [
      'r.room_id', 'r.name', 'r.description', 'r.cover_image_url',
      eb.selectFrom('room_membership as m').select(eb.fn.countAll<number>().as('n')).whereRef('m.room_id', '=', 'r.room_id').as('member_count'),
      eb.selectFrom('room_membership as m2').select('m2.user_id').whereRef('m2.room_id', '=', 'r.room_id').where('m2.user_id', '=', userId).as('me'),
    ])
    .where('r.room_id', '=', inv.room_id)
    .executeTakeFirstOrThrow();
  return {
    roomId: room.room_id,
    roomName: room.name,
    roomDescription: room.description,
    coverImageUrl: room.cover_image_url,
    memberCount: Number(room.member_count ?? 0),
    expiresAt: inv.expires_at.toISOString(),
    alreadyMember: room.me !== null,
  };
}

/** Joins the room. Expiry and the 40-member limit are re-checked inside the locking transaction. */
export async function acceptInvitation(token: string, userId: number): Promise<{ roomId: number; status: 'added' | 'already_member' }> {
  const inv = await findValidInvitation(token, userId);
  const status = await transaction(async (tx) => {
    const fresh = await tx
      .selectFrom('room_invitation')
      .select(['expires_at'])
      .where('invitation_id', '=', inv.invitation_id)
      .executeTakeFirst();
    if (!fresh) throw notFound('Invitation');
    if (fresh.expires_at.getTime() <= Date.now()) throw expiredError();
    return addMemberLocked(tx, inv.room_id, userId);
  });
  return { roomId: inv.room_id, status };
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Gestiona los enlaces de invitación con caducidad para unirse a salas privadas.

Responsabilidades principales:
- createInvitation: solo OWNER/ADMIN; genera un token aleatorio de 32 bytes y guarda únicamente su
  hash SHA-256.
- Las invitaciones pueden ser abiertas o dirigidas a un usuario registrado (que recibe un correo).
- listInvitations y revokeInvitation.
- previewInvitation y acceptInvitation: verifican caducidad y destinatario y añaden al miembro con
  addMemberLocked.

Elementos importantes:
- hashToken
- createInvitation
- listInvitations
- revokeInvitation
- previewInvitation
- acceptInvitation

Dependencias:
- node:crypto
- db/index.ts
- integrations/mailer.ts
- services/permissions.ts
- services/rooms.ts
- services/users.ts

Flujo de datos:
El token viaja solo en la URL /invite/<token>; la tabla room_invitation guarda token_hash y
expires_at.

Aspectos técnicos importantes:
- Un enlace caducado devuelve 410; un enlace dirigido a otra persona devuelve 403.
- El token en claro se muestra una sola vez al crearlo.

Lugar en la arquitectura:
Capa de servicios. Es el único mecanismo para entrar en una sala (todas son privadas).
*/

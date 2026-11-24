import { describe, expect, it } from 'vitest';
import { LIMITS } from '@rush/shared';
import { db } from '../src/db';
import { hashToken } from '../src/services/invitations';
import { outbox } from '../src/integrations/mailer';
import { hashPassword } from '../src/services/users';
import { addMember, as, createRoom, registerUser } from './helpers';

/** Inserts many users quickly (bypassing HTTP) for limit tests. */
async function bulkUsers(n: number, prefix: string): Promise<number[]> {
  const hash = await hashPassword('x-password');
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await db.insertInto('user').values({ full_name: `${prefix}${i}`, username: `${prefix}${i}`, email: `${prefix}${i}@x.test`, password_hash: hash }).executeTakeFirstOrThrow();
    await db.insertInto('user_preferences').values({ user_id: Number(r.insertId) }).execute();
    ids.push(Number(r.insertId));
  }
  return ids;
}

describe('rooms', () => {
  it('creates a room with the owner as OWNER member and a default cover', async () => {
    const owner = await registerUser();
    const res = await as(owner).post('/api/rooms', { name: 'Korean 101', description: 'Practice' });
    expect(res.status).toBe(201);
    expect(res.body.myRole).toBe('OWNER');
    expect(res.body.memberCount).toBe(1);
    expect(res.body.coverImageUrl).toMatch(/^\/covers\//);
    expect(res.body.members[0]).toMatchObject({ userId: owner.userId, role: 'OWNER' });
  });

  it(`limits a user to ${LIMITS.maxRoomsPerUser} rooms, also under concurrent requests`, async () => {
    const owner = await registerUser();
    const results = await Promise.all(
      Array.from({ length: LIMITS.maxRoomsPerUser + 3 }, (_, i) => as(owner).post('/api/rooms', { name: `R${i}` })),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(LIMITS.maxRoomsPerUser);
    expect(results.filter((r) => r.status === 409).every((r) => r.body.error.code === 'room_limit')).toBe(true);
    const { n } = await db.selectFrom('room').select((eb) => eb.fn.countAll<number>().as('n')).where('owner_user_id', '=', owner.userId).executeTakeFirstOrThrow();
    expect(Number(n)).toBe(LIMITS.maxRoomsPerUser);
  });

  it('hides rooms from non-members (404) and lists only own rooms', async () => {
    const owner = await registerUser();
    const stranger = await registerUser();
    const roomId = await createRoom(owner);
    expect((await as(stranger).get(`/api/rooms/${roomId}`)).status).toBe(404);
    expect((await as(stranger).get('/api/rooms')).body).toHaveLength(0);
    expect((await as(stranger).patch(`/api/rooms/${roomId}`, { name: 'hacked' })).status).toBe(404);
    expect((await as(stranger).delete(`/api/rooms/${roomId}`)).status).toBe(404);
  });

  it('lets owner and admins edit, but only the owner delete', async () => {
    const owner = await registerUser();
    const admin = await registerUser();
    const member = await registerUser();
    const roomId = await createRoom(owner);
    await addMember(roomId, owner, admin);
    await addMember(roomId, owner, member);
    expect((await as(owner).patch(`/api/rooms/${roomId}/members/${admin.userId}`, { role: 'ADMIN' })).status).toBe(204);
    expect((await as(admin).patch(`/api/rooms/${roomId}`, { name: 'Renamed' })).body.name).toBe('Renamed');
    expect((await as(member).patch(`/api/rooms/${roomId}`, { name: 'x' })).status).toBe(403);
    expect((await as(admin).delete(`/api/rooms/${roomId}`)).status).toBe(403);
    expect((await as(owner).delete(`/api/rooms/${roomId}`)).status).toBe(204);
  });

  it('only the owner appoints admins (A-16); admins remove only members', async () => {
    const owner = await registerUser();
    const admin = await registerUser();
    const admin2 = await registerUser();
    const member = await registerUser();
    const roomId = await createRoom(owner);
    for (const u of [admin, admin2, member]) await addMember(roomId, owner, u);
    await as(owner).patch(`/api/rooms/${roomId}/members/${admin.userId}`, { role: 'ADMIN' });
    await as(owner).patch(`/api/rooms/${roomId}/members/${admin2.userId}`, { role: 'ADMIN' });
    expect((await as(admin).patch(`/api/rooms/${roomId}/members/${member.userId}`, { role: 'ADMIN' })).status).toBe(403);
    expect((await as(admin).delete(`/api/rooms/${roomId}/members/${admin2.userId}`)).status).toBe(403);
    expect((await as(admin).delete(`/api/rooms/${roomId}/members/${owner.userId}`)).status).toBe(403);
    expect((await as(owner).patch(`/api/rooms/${roomId}/members/${owner.userId}`, { role: 'MEMBER' })).status).toBe(400);
    expect((await as(admin).delete(`/api/rooms/${roomId}/members/${member.userId}`)).status).toBe(204);
    expect(outbox.some((m) => m.to === member.email && /removed/i.test(m.subject))).toBe(true);
    expect((await as(member).get(`/api/rooms/${roomId}`)).status).toBe(404);
  });

  it('members can leave; the owner cannot', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const roomId = await createRoom(owner);
    await addMember(roomId, owner, member);
    expect((await as(owner).post(`/api/rooms/${roomId}/leave`)).status).toBe(400);
    expect((await as(member).post(`/api/rooms/${roomId}/leave`)).status).toBe(204);
    expect((await as(member).get('/api/rooms')).body).toHaveLength(0);
  });

  it('assigns predefined and own custom topics, rejects others\' custom topics', async () => {
    const owner = await registerUser();
    const other = await registerUser();
    const pre = await db.insertInto('topic').values({ name: 'Grammar', topic_type: 'PREDEFINED', created_by_user_id: null }).executeTakeFirstOrThrow();
    const mine = await as(owner).post('/api/topics', { name: 'Mine' });
    const theirs = await as(other).post('/api/topics', { name: 'Theirs' });
    const ok = await as(owner).post('/api/rooms', { name: 'T', topicIds: [Number(pre.insertId), mine.body.topicId] });
    expect(ok.status).toBe(201);
    expect(ok.body.topics.map((t: { name: string }) => t.name).sort()).toEqual(['Grammar', 'Mine']);
    const bad = await as(owner).patch(`/api/rooms/${ok.body.roomId}`, { topicIds: [theirs.body.topicId] });
    expect(bad.status).toBe(400);
  });
});

describe('room membership limit', () => {
  it(`caps a room at ${LIMITS.maxMembersPerRoom} members including the owner, even with concurrent joins`, async () => {
    const owner = await registerUser();
    const roomId = await createRoom(owner);
    const ids = await bulkUsers(LIMITS.maxMembersPerRoom - 2, 'm');
    await db.insertInto('room_membership').values(ids.map((user_id) => ({ room_id: roomId, user_id }))).execute();
    // 39 members now; 5 users race for the last seat
    const racers = await Promise.all(Array.from({ length: 5 }, () => registerUser()));
    const inv = await as(owner).post(`/api/rooms/${roomId}/invitations`, {});
    const results = await Promise.all(racers.map((u) => as(u).post(`/api/invitations/${inv.body.token}/accept`)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409 && r.body.error.code === 'room_full')).toHaveLength(4);
    const { n } = await db.selectFrom('room_membership').select((eb) => eb.fn.countAll<number>().as('n')).where('room_id', '=', roomId).executeTakeFirstOrThrow();
    expect(Number(n)).toBe(LIMITS.maxMembersPerRoom);
  });
});

describe('invitations', () => {
  it('stores only the SHA-256 hash of the token', async () => {
    const owner = await registerUser();
    const roomId = await createRoom(owner);
    const inv = await as(owner).post(`/api/rooms/${roomId}/invitations`, {});
    expect(inv.status).toBe(201);
    expect(inv.body.url).toContain(inv.body.token);
    const row = await db.selectFrom('room_invitation').selectAll().where('invitation_id', '=', inv.body.invitationId).executeTakeFirstOrThrow();
    expect(row.token_hash).toBe(hashToken(inv.body.token));
    expect(row.token_hash).not.toContain(inv.body.token);
    const list = await as(owner).get(`/api/rooms/${roomId}/invitations`);
    expect(JSON.stringify(list.body)).not.toContain(inv.body.token);
  });

  it('only OWNER/ADMIN can create invitations', async () => {
    const owner = await registerUser();
    const member = await registerUser();
    const roomId = await createRoom(owner);
    await addMember(roomId, owner, member);
    expect((await as(member).post(`/api/rooms/${roomId}/invitations`, {})).status).toBe(403);
  });

  it('previews and joins with a valid link; multi-use until expiry', async () => {
    const owner = await registerUser();
    const a = await registerUser();
    const b = await registerUser();
    const roomId = await createRoom(owner, 'Joinable');
    const inv = await as(owner).post(`/api/rooms/${roomId}/invitations`, {});
    const preview = await as(a).get(`/api/invitations/${inv.body.token}`);
    expect(preview.body).toMatchObject({ roomName: 'Joinable', alreadyMember: false, memberCount: 1 });
    expect((await as(a).post(`/api/invitations/${inv.body.token}/accept`)).body).toEqual({ roomId, status: 'added' });
    expect((await as(a).post(`/api/invitations/${inv.body.token}/accept`)).body.status).toBe('already_member');
    expect((await as(b).post(`/api/invitations/${inv.body.token}/accept`)).body.status).toBe('added');
  });

  it('rejects expired invitations', async () => {
    const owner = await registerUser();
    const user = await registerUser();
    const roomId = await createRoom(owner);
    const token = 'expiredtokenexpiredtokenexpired0000';
    await db.insertInto('room_invitation').values({
      room_id: roomId, created_by_user_id: owner.userId, token_hash: hashToken(token),
      created_at: new Date(Date.now() - 3 * 3600_000), expires_at: new Date(Date.now() - 3600_000),
    }).execute();
    const res = await as(user).post(`/api/invitations/${token}/accept`);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('invitation_expired');
    expect((await as(user).get(`/api/invitations/${token}`)).status).toBe(410);
  });

  it('rejects unknown tokens and fixes expiry at exactly one hour, ignoring client input', async () => {
    const owner = await registerUser();
    const roomId = await createRoom(owner);
    expect((await as(owner).get('/api/invitations/does-not-exist-token-000000')).status).toBe(404);
    // The client cannot choose or extend the validity period: it is always one hour from the
    // server-side creation time, even if a different duration is sent.
    const inv = await as(owner).post(`/api/rooms/${roomId}/invitations`, { expiresInHours: 24 * 31 });
    expect(inv.status).toBe(201);
    const row = await db
      .selectFrom('room_invitation')
      .select(['created_at', 'expires_at'])
      .where('invitation_id', '=', inv.body.invitationId)
      .executeTakeFirstOrThrow();
    expect(row.expires_at.getTime() - row.created_at.getTime()).toBe(3600_000);
  });

  it('targeted invitations email the invitee and cannot be used by others', async () => {
    const owner = await registerUser();
    const invitee = await registerUser();
    const other = await registerUser();
    const roomId = await createRoom(owner);
    const inv = await as(owner).post(`/api/rooms/${roomId}/invitations`, { invitee: invitee.username });
    expect(inv.body.invitedUsername).toBe(invitee.username);
    expect(outbox.find((m) => m.to === invitee.email)?.text).toContain(inv.body.url);
    expect((await as(other).post(`/api/invitations/${inv.body.token}/accept`)).status).toBe(403);
    expect((await as(invitee).post(`/api/invitations/${inv.body.token}/accept`)).status).toBe(200);
    expect((await as(owner).post(`/api/rooms/${roomId}/invitations`, { invitee: invitee.email })).status).toBe(409);
    expect((await as(owner).post(`/api/rooms/${roomId}/invitations`, { invitee: 'nobody-here' })).status).toBe(404);
  });

  it('revoked invitations stop working', async () => {
    const owner = await registerUser();
    const user = await registerUser();
    const roomId = await createRoom(owner);
    const inv = await as(owner).post(`/api/rooms/${roomId}/invitations`, {});
    expect((await as(owner).delete(`/api/rooms/${roomId}/invitations/${inv.body.invitationId}`)).status).toBe(204);
    expect((await as(user).post(`/api/invitations/${inv.body.token}/accept`)).status).toBe(404);
  });
});

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Pruebas de salas, límites de membresía e invitaciones.

Responsabilidades principales:
- Creación de salas con membresía OWNER y portada por defecto.
- Límite de 10 salas y de 40 miembros incluso con peticiones simultáneas.
- Privacidad (404 para no miembros), roles y expulsiones.
- Invitaciones: hash del token, caducidad, invitaciones dirigidas y revocadas.

Elementos importantes:
- 15 casos de prueba
- bulkUsers (inserción rápida de usuarios)

Dependencias:
- vitest
- test/helpers.ts
- src/db/index.ts
- src/services/invitations.ts

Flujo de datos:
Comprueba la API de salas y el contenido de MySQL.

Aspectos técnicos importantes:
- La prueba de concurrencia envía cinco solicitudes a la vez para el último puesto libre.

Lugar en la arquitectura:
Pruebas automatizadas. Valida las reglas de negocio de salas.
*/

import { sql } from 'kysely';
import type { Db } from './index';

/**
 * Additive, idempotent schema migrations for databases created before a change to
 * database/rush_schema.sql. Each step checks information_schema first, so running this on a fresh
 * database (which already has the columns) or running it twice changes nothing. No data is deleted.
 */

async function columnExists(db: Db, table: string, column: string): Promise<boolean> {
  const r = await sql<{ n: number }>`
    SELECT COUNT(*) AS n FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table} AND COLUMN_NAME = ${column}
  `.execute(db);
  return Number(r.rows[0]?.n ?? 0) > 0;
}

/** Applies the pending migrations and returns a description of each one that ran. */
export async function runMigrations(db: Db): Promise<string[]> {
  const applied: string[] = [];

  // 2026-11: one global time limit per quiz instead of one per question.
  if (!(await columnExists(db, 'quiz', 'total_time_limit_seconds'))) {
    await sql`ALTER TABLE quiz ADD COLUMN total_time_limit_seconds SMALLINT UNSIGNED NOT NULL DEFAULT 300 AFTER is_in_library`.execute(db);
    // Existing quizzes keep roughly the same total duration: the sum of their old per-question
    // limits, rounded up to whole minutes and kept within 1–60 minutes. updated_at is preserved.
    await sql`
      UPDATE quiz q
      LEFT JOIN (SELECT quiz_id, SUM(time_limit_seconds) AS total FROM question GROUP BY quiz_id) t ON t.quiz_id = q.quiz_id
      SET q.total_time_limit_seconds = LEAST(3600, GREATEST(60, CEIL(COALESCE(t.total, 300) / 60) * 60)),
          q.updated_at = q.updated_at
    `.execute(db);
    await sql`ALTER TABLE quiz ADD CONSTRAINT chk_quiz_total_time_limit CHECK (total_time_limit_seconds BETWEEN 60 AND 3600)`.execute(db);
    applied.push('quiz.total_time_limit_seconds (backfilled from the per-question limits)');
  }

  // 2026-11: the session records its winning participant (the highest final score).
  if (!(await columnExists(db, 'quiz_session', 'winner_user_id'))) {
    await sql`ALTER TABLE quiz_session ADD COLUMN winner_user_id BIGINT UNSIGNED NULL AFTER ended_at`.execute(db);
    await sql`
      ALTER TABLE quiz_session ADD CONSTRAINT fk_quiz_session_winner_user_id
      FOREIGN KEY (winner_user_id) REFERENCES user (user_id) ON DELETE SET NULL ON UPDATE RESTRICT
    `.execute(db);
    applied.push('quiz_session.winner_user_id');
  }
  if (!(await columnExists(db, 'quiz_attempt', 'finished_at'))) {
    await sql`ALTER TABLE quiz_attempt ADD COLUMN finished_at DATETIME NULL AFTER disconnected_at`.execute(db);
    applied.push('quiz_attempt.finished_at');
  }

  return applied;
}

/*
=========================================================
EXPLICACIÓN DEL ARCHIVO
=========================================================

Propósito: Actualiza bases de datos creadas con una versión anterior de rush_schema.sql sin borrar
datos.

Responsabilidades principales:
- Añadir quiz.total_time_limit_seconds (tiempo global del cuestionario) y rellenarlo para los
  cuestionarios existentes con la suma de los antiguos tiempos por pregunta, redondeada a minutos.
- Añadir quiz_session.winner_user_id (primer jugador en terminar) y quiz_attempt.finished_at.

Elementos importantes:
- runMigrations(db): devuelve la lista de cambios aplicados.

Dependencias:
- kysely (sql)
- db/index.ts

Flujo de datos:
Se ejecuta al arrancar el backend (index.ts) y con npm run db:migrate. Consulta
information_schema antes de cada paso, por lo que es idempotente.

Aspectos técnicos importantes:
- Solo añade columnas y restricciones; nunca elimina ni reinicia datos.
- En una base nueva (creada con rush_schema.sql actual) no hace nada.

Lugar en la arquitectura:
Capa de datos del backend. Mantiene compatibles las bases existentes con el esquema actual.
*/

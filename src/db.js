import pg from "pg";

const { Pool } = pg;

export function createPool() {
  return new Pool({
    ...(process.env.DATABASE_URL
      ? { connectionString: process.env.DATABASE_URL }
      : {
          host: process.env.PGHOST,
          port: Number(process.env.PGPORT ?? 5432),
          database: process.env.PGDATABASE,
          user: process.env.PGUSER,
          password: process.env.PGPASSWORD,
        }),
    max: 10,
    connectionTimeoutMillis: 5000,
  });
}

export async function initializeDatabase(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS appointments (
      id BIGSERIAL PRIMARY KEY,
      doctor_id BIGINT NOT NULL,
      patient_name TEXT NOT NULL,
      patient_email TEXT NOT NULL,
      starts_at TIMESTAMPTZ NOT NULL,
      status TEXT NOT NULL DEFAULT 'BOOKED' CHECK (status IN ('BOOKED', 'CANCELLED')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE UNIQUE INDEX IF NOT EXISTS uq_active_doctor_slot
      ON appointments (doctor_id, starts_at)
      WHERE status = 'BOOKED';
  `);
}

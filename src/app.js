import express from "express";

function isValidDate(value) {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

function doctorServiceUrl() {
  return (process.env.DOCTOR_SERVICE_URL ?? "http://localhost:3001").replace(/\/$/, "");
}

async function getDoctorSlots(doctorId, from, to) {
  let response;
  try {
    const url = new URL(`${doctorServiceUrl()}/doctors/${doctorId}/slots`);
    if (from) url.searchParams.set("from", from);
    if (to) url.searchParams.set("to", to);
    response = await fetch(url);
  } catch (error) {
    throw Object.assign(new Error("doctor service is unavailable"), {
      statusCode: 503,
      cause: error,
    });
  }
  if (!response.ok) {
    if (response.status === 404) {
      throw Object.assign(new Error("doctor not found"), { statusCode: 404 });
    }
    throw Object.assign(new Error("doctor service returned an error"), {
      statusCode: 502,
    });
  }
  return response.json();
}

export function createApp(pool, dependencies = {}) {
  const app = express();
  const fetchSlots = dependencies.getDoctorSlots ?? getDoctorSlots;
  app.use(express.json({ limit: "32kb" }));

  app.get("/health", async (_req, res) => {
    await pool.query("SELECT 1");
    res.json({ status: "ok", service: "appointment-service" });
  });

  app.get("/availability", async (req, res, next) => {
    const doctorId = Number(req.query.doctorId);
    const { from, to } = req.query;
    if (!Number.isSafeInteger(doctorId) || doctorId < 1 || !isValidDate(from) || !isValidDate(to)) {
      return res.status(400).json({
        error: "positive doctorId and valid from/to timestamps are required",
      });
    }
    if (Date.parse(from) > Date.parse(to)) {
      return res.status(400).json({ error: "from must be earlier than or equal to to" });
    }

    try {
      const slots = await fetchSlots(doctorId, from, to);
      if (slots.length === 0) return res.json([]);
      const { rows } = await pool.query(
        `SELECT starts_at FROM appointments
         WHERE doctor_id = $1 AND status = 'BOOKED'
           AND starts_at = ANY($2::timestamptz[])`,
        [doctorId, slots.map((slot) => slot.starts_at)],
      );
      const booked = new Set(rows.map((row) => new Date(row.starts_at).toISOString()));
      res.json(slots.filter((slot) => !booked.has(new Date(slot.starts_at).toISOString())));
    } catch (error) {
      next(error);
    }
  });

  app.post("/appointments", async (req, res, next) => {
    const doctorId = Number(req.body?.doctorId);
    const patientName = typeof req.body?.patientName === "string"
      ? req.body.patientName.trim()
      : "";
    const patientEmail = typeof req.body?.patientEmail === "string"
      ? req.body.patientEmail.trim().toLowerCase()
      : "";
    const { startsAt } = req.body ?? {};
    if (
      !Number.isSafeInteger(doctorId) || doctorId < 1 ||
      !patientName || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patientEmail ?? "") ||
      !isValidDate(startsAt)
    ) {
      return res.status(400).json({
        error: "doctorId, patientName, valid patientEmail, and startsAt are required",
      });
    }
    if (Date.parse(startsAt) <= Date.now()) {
      return res.status(400).json({ error: "startsAt must be in the future" });
    }

    try {
      const slots = await fetchSlots(doctorId, startsAt, startsAt);
      const requestedTime = new Date(startsAt).toISOString();
      const isScheduled = slots.some(
        (slot) => new Date(slot.starts_at).toISOString() === requestedTime,
      );
      if (!isScheduled) {
        return res.status(409).json({ error: "requested time is not an available doctor slot" });
      }

      const { rows } = await pool.query(
        `INSERT INTO appointments (doctor_id, patient_name, patient_email, starts_at)
         VALUES ($1, $2, $3, $4)
         RETURNING id, doctor_id, patient_name, patient_email, starts_at, status`,
        [doctorId, patientName, patientEmail, startsAt],
      );
      return res.status(201).json(rows[0]);
    } catch (error) {
      if (error.code === "23505") {
        return res.status(409).json({ error: "this doctor slot has already been booked" });
      }
      return next(error);
    }
  });

  app.get("/appointments", async (req, res) => {
    const patientEmail = typeof req.query.patientEmail === "string"
      ? req.query.patientEmail.trim().toLowerCase()
      : "";
    if (!patientEmail) {
      return res.status(400).json({ error: "patientEmail query parameter is required" });
    }
    const { rows } = await pool.query(
      `SELECT id, doctor_id, patient_name, patient_email, starts_at, status
       FROM appointments WHERE patient_email = $1 ORDER BY starts_at`,
      [patientEmail],
    );
    res.json(rows);
  });

  app.get("/appointments/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "appointment id must be a positive integer" });
    }
    const { rows } = await pool.query(
      `SELECT id, doctor_id, patient_name, patient_email, starts_at, status
       FROM appointments WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return res.status(404).json({ error: "appointment not found" });
    res.json(rows[0]);
  });

  app.delete("/appointments/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "appointment id must be a positive integer" });
    }
    const { rows } = await pool.query(
      `UPDATE appointments SET status = 'CANCELLED'
       WHERE id = $1 AND status = 'BOOKED'
       RETURNING id, doctor_id, patient_name, patient_email, starts_at, status`,
      [id],
    );
    if (rows.length === 0) {
      const existing = await pool.query("SELECT id FROM appointments WHERE id = $1", [id]);
      if (existing.rowCount === 0) return res.status(404).json({ error: "appointment not found" });
      return res.status(409).json({ error: "appointment is already cancelled" });
    }
    res.json(rows[0]);
  });

  app.use((error, _req, res, _next) => {
    if (error.statusCode) return res.status(error.statusCode).json({ error: error.message });
    console.error(error);
    return res.status(500).json({ error: "internal server error" });
  });

  return app;
}

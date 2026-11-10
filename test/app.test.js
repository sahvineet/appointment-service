import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { createApp } from "../src/app.js";

const pool = {
  query: async (sql) => {
    if (sql.includes("INSERT INTO appointments")) {
      return {
        rows: [{
          id: 42,
          doctor_id: 7,
          patient_name: "Pat Example",
          patient_email: "pat@example.com",
          starts_at: "2030-01-01T10:00:00.000Z",
          status: "BOOKED",
        }],
      };
    }
    throw new Error(`Unexpected SQL in test: ${sql}`);
  },
};

test("rejects invalid booking data", async () => {
  const app = createApp(pool);
  const response = await request(app).post("/appointments").send({ doctorId: "bad" });
  assert.equal(response.status, 400);
});

test("booking reports the doctor service being unavailable", async () => {
  const app = createApp(pool, {
    getDoctorSlots: async () => {
      throw Object.assign(new Error("doctor service is unavailable"), { statusCode: 503 });
    },
  });
  const response = await request(app)
    .post("/appointments")
    .send({
      doctorId: 7,
      patientName: "Pat Example",
      patientEmail: "pat@example.com",
      startsAt: "2030-01-01T10:00:00.000Z",
    });
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "doctor service is unavailable");
});

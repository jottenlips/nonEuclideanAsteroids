import { http } from "@ampt/sdk";
import { data } from "@ampt/data";
import express from "express";
import cors from "cors";

const app = express();
app.use(cors({
  origin: [
    "https://jottenlips.github.io",
    "http://localhost:8081",
    "http://localhost:8082",
  ],
}));
app.use(express.json());

const TTL = 86400; // 24 hours

function sanitizeRoomName(name) {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 16);
}

// Create room - host posts their SDP offer + chosen room name
app.post("/api/rooms", async (req, res) => {
  const { offer, room, name } = req.body;
  if (!offer || !room) return res.status(400).json({ error: "offer and room required" });
  const roomCode = sanitizeRoomName(room);
  if (roomCode.length < 3) return res.status(400).json({ error: "room name must be 3+ alphanumeric characters" });
  const existing = await data.get(`rooms:${roomCode}`);
  if (existing && existing.offer) return res.status(409).json({ error: "room already exists" });
  await data.set(`rooms:${roomCode}`, { offer, name: name || "", answer: null, created: Date.now() }, { ttl: TTL });
  res.json({ code: roomCode });
});

// Get offer - guest fetches the SDP offer by room name
app.get("/api/rooms/:code", async (req, res) => {
  const room = await data.get(`rooms:${req.params.code.toUpperCase()}`);
  if (!room || !room.offer) return res.status(404).json({ error: "room not found" });
  res.json({ offer: room.offer, name: room.name });
});

// Submit answer - guest posts their SDP answer
app.post("/api/rooms/:code/answer", async (req, res) => {
  const { answer } = req.body;
  if (!answer) return res.status(400).json({ error: "answer required" });
  const key = `rooms:${req.params.code.toUpperCase()}`;
  const room = await data.get(key);
  if (!room || !room.offer) return res.status(404).json({ error: "room not found" });
  await data.set(key, { offer: room.offer, name: room.name, answer, created: room.created }, { ttl: TTL });
  res.json({ ok: true });
});

// Get answer - host polls for the SDP answer
app.get("/api/rooms/:code/answer", async (req, res) => {
  const room = await data.get(`rooms:${req.params.code.toUpperCase()}`);
  if (!room || !room.offer) return res.status(404).json({ error: "room not found" });
  if (!room.answer) return res.json({ answer: null });
  res.json({ answer: room.answer });
});

http.node.use(app);

// Vercel serverless function: answers student questions using your Supabase data + Gemini.
// Needs these Environment Variables in Vercel: GEMINI_API_KEY, SUPABASE_URL, SUPABASE_KEY
// Optional: GEMINI_MODEL (default below)

const TABLES = ["notices", "exams", "rooms", "departments", "faqs"];

async function loadData() {
  const out = {};
  await Promise.all(TABLES.map(async t => {
    const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${t}?select=*`, {
      headers: { apikey: process.env.SUPABASE_KEY },
    });
    if (!r.ok) throw new Error(`Supabase ${t}: ${r.status}`);
    const rows = await r.json();
    out[t] = rows.map(({ id, ...rest }) => rest); // drop internal ids
  }));
  return out;
}

function mineFor(data, course, sem) {
  if (!course || !sem) return null;
  const rc = c => String(c).replace(/\s*\d+(st|nd|rd|th)\s*sem.*$/i, "").trim();
  const ord = new RegExp(`\\b${sem}(st|nd|rd|th)\\b`, "i");
  const courses = [...new Set([...data.exams.map(e => e.course), ...data.rooms.map(r => rc(r.class))])].filter(Boolean);
  return {
    exams: data.exams.filter(e => e.course === course && String(e.semester) === sem),
    timetable: data.rooms.filter(r => rc(r.class) === course && ord.test(r.class)),
    notices: data.notices.filter(n => {
      const txt = (n.title + " " + n.description).toLowerCase(), named = courses.filter(k => txt.includes(String(k).toLowerCase()));
      return !named.length || named.includes(course);
    }),
  };
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST" });
  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body || {};
    const msgs = (Array.isArray(body.messages) ? body.messages : [])
      .slice(-6)
      .filter(m => m && typeof m.text === "string" && (m.role === "user" || m.role === "model"))
      .map(m => ({ role: m.role, parts: [{ text: m.text.slice(0, 500) }] }));
    if (!msgs.length || msgs[msgs.length - 1].role !== "user")
      return res.status(400).json({ error: "Send a question." });

    const pr = body.profile && typeof body.profile === "object" ? body.profile : {};
    const course = typeof pr.course === "string" ? pr.course.replace(/[^\w .+&()-]/g, "").slice(0, 30) : "";
    const sem = /^\d{1,2}$/.test(String(pr.sem || "")) ? String(pr.sem) : "";
    const hindi = body.lang === "hi";
    const data = await loadData();
    const mine = mineFor(data, course, sem);
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const weekday = new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata", weekday: "long" });
    const nowTime = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
    const system =
      `You are College Assistant, a helpful assistant for college students. Today's date is ${today} (${weekday}), and the time is ${nowTime} in India.\n` +
      `Answer ONLY using the COLLEGE DATA below. If the answer is not in the data, say you don't have that information ` +
      `and suggest contacting the college office or the relevant department. Never invent dates, rooms, phone numbers or rules.\n` +
      `Be warm, friendly and encouraging, like a helpful senior student. Keep answers short (2 to 4 sentences), because your reply will also be read aloud.\n` +
      `Use plain text with no tables or headings. You may use **bold** for key facts such as dates, times and room numbers, and at most one emoji.\n` +
      `Reply in the same language the student used (English or Hindi).\n\n` +
      (hindi ? `Unless the student writes in English, reply in Hindi (Devanagari script).\n` : "") +
      (mine ? `The student is in ${course}, Semester ${sem}. When they say "my" (my exam, my classes, my notices), answer from STUDENT'S CLASS DATA first and do not mention other courses unless asked.\n\nSTUDENT'S CLASS DATA (JSON):\n${JSON.stringify(mine)}\n\n` : "\n") +
      `ALL COLLEGE DATA (JSON):\n${JSON.stringify(data)}`;

    const model = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: msgs,
        generationConfig: { temperature: 0.2, maxOutputTokens: 700 },
      }),
    });
    if (r.status === 429) return res.status(200).json({ reply: "The assistant is busy right now. Please try again in a minute." });
    if (!r.ok) { console.error("Gemini error", r.status, await r.text()); return res.status(502).json({ error: "AI service error" }); }
    const j = await r.json();
    const reply = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    return res.status(200).json({ reply: reply || "Sorry, I could not answer that. Please contact the college office." });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Something went wrong." });
  }
};

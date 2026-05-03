// ── Stub server ────────────────────────────────────────────────────
// Email is now sent directly from the browser via EmailJS.
// This file is kept as a required stub by Figma Make's build system.
// ──────────────────────────────────────────────────────────────────

import { Hono } from "npm:hono";

const app = new Hono();
app.get("/make-server-d732bcea/health", (c) =>
  c.json({ status: "ok", note: "Email is handled client-side via EmailJS." }),
);

Deno.serve(app.fetch);

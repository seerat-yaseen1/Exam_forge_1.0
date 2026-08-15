#!/usr/bin/env node
/**
 * POSTINSTALL — put the vendored face-api weights where the app serves them.
 *
 * `public/models/` is gitignored (they are a build output, not source), and
 * FaceMonitor loads them from `/models` at runtime, so something has to place
 * them on every install. This is that something.
 *
 * WHAT IT REPLACED, and why it matters (audit S-8 / R-5)
 *
 *   mkdir -p public/models && curl -fsSL https://raw.githubusercontent.com/…/master/weights/… -o …
 *
 * Vercel runs the install, so that curl was on the critical path of every
 * deploy: unreachable host, renamed file, or an archived upstream repository
 * and THE WHOLE APP STOPS DEPLOYING — over a webcam model. It also pointed at
 * a moving branch owned by someone else, and verified nothing.
 *
 * Now the bytes live in vendor/face-api/ (204 KB, checksummed) and this copies
 * them. No network at install time, on any machine.
 *
 * ── IT MUST NOT FAIL THE INSTALL ──────────────────────────────────
 *
 * Deliberate, and the opposite of how the curl behaved. Face detection is one
 * advisory proctoring signal; FaceMonitor's own header says that if the models
 * fail to load the webcam PiP still shows and detection is skipped. Every
 * other part of the platform — sitting an exam, marking, administration —
 * neither knows nor cares that these files exist.
 *
 * So a missing weight file is a degraded feature, and degrading a feature is
 * not worth refusing to build the product. It warns loudly and exits 0; the
 * absence surfaces in the browser console at the one screen that uses it.
 * `npm run verify:face-models` is the check that DOES fail, for CI or a
 * pre-deploy gate.
 */

import { copyFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FROM = path.join(ROOT, 'vendor', 'face-api');
const TO = path.join(ROOT, 'public', 'models');

const FILES = [
  'tiny_face_detector_model-weights_manifest.json',
  'tiny_face_detector_model-shard1',
];

const exists = (p) => access(p).then(() => true, () => false);

async function main() {
  await mkdir(TO, { recursive: true });
  let copied = 0;
  const missing = [];

  for (const name of FILES) {
    const src = path.join(FROM, name);
    if (!(await exists(src))) { missing.push(name); continue; }
    await copyFile(src, path.join(TO, name));
    copied++;
  }

  if (missing.length > 0) {
    console.warn(
      `[face-models] MISSING from vendor/face-api: ${missing.join(', ')}\n`
      + '[face-models] In-exam face detection will be unavailable; everything\n'
      + '[face-models] else is unaffected. Re-vendor with:\n'
      + '[face-models]   npm run vendor:face-models\n'
      + '[face-models] (needs network access to raw.githubusercontent.com, once)',
    );
    return;   // exit 0 on purpose — see the header
  }
  console.log(`[face-models] ${copied} weight file(s) → public/models/`);
}

main().catch((err) => {
  // Even an unexpected failure must not break the install, for the same reason.
  console.warn('[face-models] copy failed, face detection will be unavailable:', err.message);
});

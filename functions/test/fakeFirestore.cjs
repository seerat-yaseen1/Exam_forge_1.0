// ═══════════════════════════════════════════════════════════════════════════
// IN-MEMORY FIRESTORE — enough of the Admin SDK surface to RUN the real
// callables in functions/src/index.ts rather than transcribe their arithmetic.
//
// WHY THIS AND NOT A TRANSCRIPTION
// timing.sweep.cjs proves examTimingCore. Every freeze defect found so far
// lives OUTSIDE the core — in submitSection's inline deadline expressions, in
// verifyAndResume's increment, in what unfreezeAttempt does and does not
// recompute. A test that re-types those expressions agrees with them by
// construction and proves nothing. This one calls the compiled production
// handler and reads what it actually wrote.
//
// Real firebase-admin Timestamp/FieldValue sentinels are used unchanged; only
// the storage and query layer is faked.
// ═══════════════════════════════════════════════════════════════════════════

const { Timestamp, FieldValue } = require('firebase-admin/firestore');

const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v, tsReplacer), tsReviver));

// Timestamps must survive the structural clone as Timestamps — answersLockedAfter
// is one, and lockInstantMs() dispatches on `.toMillis`.
function tsReplacer(_k, v) {
  if (v && typeof v === 'object' && v.__ts__ === true) return v;
  return v;
}
function tsReviver(_k, v) {
  if (v && typeof v === 'object' && v.__ts__ === true) {
    return Timestamp.fromMillis(v.ms);
  }
  return v;
}
// JSON.stringify calls toJSON() on Timestamp, which loses the type. Pre-walk
// instead so the marker survives.
function encode(v) {
  if (v instanceof Timestamp) return { __ts__: true, ms: v.toMillis() };
  if (Array.isArray(v)) return v.map(encode);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = encode(v[k]);
    return o;
  }
  return v;
}
function decode(v) {
  if (v && typeof v === 'object' && v.__ts__ === true) return Timestamp.fromMillis(v.ms);
  if (Array.isArray(v)) return v.map(decode);
  if (v && typeof v === 'object') {
    const o = {};
    for (const k of Object.keys(v)) o[k] = decode(v[k]);
    return o;
  }
  return v;
}
const deepCopy = (v) => decode(JSON.parse(JSON.stringify(encode(v))));

// ── Sentinel detection ─────────────────────────────────────────────
// FieldValue sentinels are opaque classes; identify them by constructor name
// and by the arguments captured on the instance.
function sentinelKind(v) {
  if (!v || typeof v !== 'object') return null;
  const n = v.constructor && v.constructor.name;
  if (n === 'DeleteTransform') return 'delete';
  if (n === 'NumericIncrementTransform') return 'increment';
  if (n === 'ArrayUnionTransform') return 'arrayUnion';
  if (n === 'ArrayRemoveTransform') return 'arrayRemove';
  if (n === 'ServerTimestampTransform') return 'serverTimestamp';
  return null;
}
function sentinelOperand(v) {
  // firebase-admin stores the operand on `.operand` (increment) or `.elements`.
  if (v.operand !== undefined) return v.operand;
  if (v.elements !== undefined) return v.elements;
  // Fall back to the first own non-function property.
  for (const k of Object.keys(v)) {
    if (typeof v[k] !== 'function') return v[k];
  }
  return undefined;
}

function setPath(obj, path, value) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (typeof cur[p] !== 'object' || cur[p] === null || Array.isArray(cur[p])) cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}
function getPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}
function delPath(obj, path) {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    cur = cur[parts[i]];
    if (cur === null || cur === undefined) return;
  }
  delete cur[parts[parts.length - 1]];
}

/** Apply an `update()` payload (dot-paths + sentinels) onto a stored doc. */
function applyUpdate(doc, patch) {
  for (const key of Object.keys(patch)) {
    const val = patch[key];
    const kind = sentinelKind(val);
    if (kind === 'delete') { delPath(doc, key); continue; }
    if (kind === 'increment') {
      const cur = getPath(doc, key);
      setPath(doc, key, (typeof cur === 'number' ? cur : 0) + sentinelOperand(val));
      continue;
    }
    if (kind === 'arrayUnion') {
      const cur = getPath(doc, key);
      const arr = Array.isArray(cur) ? cur.slice() : [];
      const add = sentinelOperand(val) || [];
      for (const el of add) {
        if (!arr.some((x) => JSON.stringify(encode(x)) === JSON.stringify(encode(el)))) arr.push(deepCopy(el));
      }
      setPath(doc, key, arr);
      continue;
    }
    if (kind === 'arrayRemove') {
      const cur = getPath(doc, key);
      const rm = (sentinelOperand(val) || []).map((x) => JSON.stringify(encode(x)));
      setPath(doc, key, (Array.isArray(cur) ? cur : []).filter(
        (x) => !rm.includes(JSON.stringify(encode(x)))));
      continue;
    }
    if (kind === 'serverTimestamp') { setPath(doc, key, Timestamp.now()); continue; }
    if (val === undefined) continue;                 // Firestore rejects these
    setPath(doc, key, deepCopy(val));
  }
}

class Snap {
  constructor(id, data, ref) {
    this.id = id;
    this._data = data;
    this.ref = ref;
    this.exists = data !== undefined;
  }
  data() { return this._data === undefined ? undefined : deepCopy(this._data); }
  get(k) { return getPath(this._data ?? {}, k); }
}

class DocRef {
  constructor(db, path) { this._db = db; this.path = path; this.id = path.split('/').pop(); }
  async get() { return new Snap(this.id, this._db._docs.get(this.path), this); }
  async set(data, opts) {
    this._db._writes.push({ op: 'set', path: this.path });
    if (opts && opts.merge) {
      const cur = this._db._docs.get(this.path) ?? {};
      applyUpdate(cur, data);
      this._db._docs.set(this.path, cur);
    } else {
      const fresh = {};
      applyUpdate(fresh, data);
      this._db._docs.set(this.path, fresh);
    }
  }
  async update(data) {
    if (!this._db._docs.has(this.path)) {
      const e = new Error(`NOT_FOUND: no document to update: ${this.path}`);
      e.code = 5;
      throw e;
    }
    this._db._writes.push({ op: 'update', path: this.path, keys: Object.keys(data) });
    const cur = this._db._docs.get(this.path);
    applyUpdate(cur, data);
  }
  async delete() {
    this._db._writes.push({ op: 'delete', path: this.path });
    this._db._docs.delete(this.path);
  }
}

class Query {
  constructor(db, coll, filters = [], lim = null) {
    this._db = db; this._coll = coll; this._filters = filters; this._lim = lim;
  }
  where(field, op, value) { return new Query(this._db, this._coll, [...this._filters, [field, op, value]], this._lim); }
  limit(n) { return new Query(this._db, this._coll, this._filters, n); }
  // NO-OP, deliberately: every suite here asserts on SETS of documents, never
  // on their order, so implementing a comparator would add surface without
  // adding coverage. It is recorded rather than silently accepted because it
  // is not free — getAllocationPreviewPage (index.ts:10411) pages with
  // orderBy('__name__') + startAfter(), and startAfter does not exist on this
  // class at all, so that callable would throw here rather than page. It has
  // no test today. Anything written to cover it needs the real emulator.
  orderBy() { return this; }
  async get() {
    const prefix = `${this._coll}/`;
    let docs = [];
    for (const [path, data] of this._db._docs) {
      if (!path.startsWith(prefix) || path.slice(prefix.length).includes('/')) continue;
      let ok = true;
      for (const [f, op, v] of this._filters) {
        const cur = getPath(data, f);
        const n = (x) => (x && typeof x.toMillis === 'function' ? x.toMillis() : x);
        if (op === '==') ok = ok && cur === v;
        else if (op === '<') ok = ok && cur !== undefined && n(cur) < n(v);
        else if (op === '<=') ok = ok && cur !== undefined && n(cur) <= n(v);
        else if (op === '>') ok = ok && cur !== undefined && n(cur) > n(v);
        else if (op === '>=') ok = ok && cur !== undefined && n(cur) >= n(v);
        else if (op === 'in') ok = ok && Array.isArray(v) && v.includes(cur);
        else if (op === 'array-contains') ok = ok && Array.isArray(cur) && cur.includes(v);
        // Audit 2026-08-06: this chain used to have no else, so an operator it
        // did not implement — '!=', 'not-in', 'array-contains-any' — left `ok`
        // untouched and the filter silently did NOTHING. The query then
        // returned every document in the collection, and a probe asserting
        // "the wrong rows are excluded" passed by getting them all back. A
        // false GREEN is worse than a missing feature, so an unsupported
        // operator now fails loudly. Zero production call sites use these
        // three today; this exists so that adding one cannot quietly weaken
        // whichever suite covers it.
        else throw new Error(`fakeFirestore: unsupported query operator '${op}' on field '${f}'`);
        if (!ok) break;
      }
      if (ok) docs.push(new Snap(path.split('/').pop(), data, new DocRef(this._db, path)));
    }
    if (this._lim !== null) docs = docs.slice(0, this._lim);
    return { docs, size: docs.length, empty: docs.length === 0, forEach: (f) => docs.forEach(f) };
  }
}

class CollRef extends Query {
  constructor(db, name) { super(db, name); this._name = name; }
  doc(id) { return new DocRef(this._db, `${this._name}/${id ?? `auto_${++this._db._auto}`}`); }
}

class Txn {
  constructor(db) { this._db = db; this._ops = []; }
  async get(refOrQuery) {
    if (this._ops.length > 0) throw new Error('TXN_READ_AFTER_WRITE: Firestore forbids this.');
    return refOrQuery.get();
  }
  set(ref, data, opts) { this._ops.push(() => ref.set(data, opts)); return this; }
  update(ref, data) { this._ops.push(() => ref.update(data)); return this; }
  delete(ref) { this._ops.push(() => ref.delete()); return this; }
  async _commit() { for (const op of this._ops) await op(); }
}

class Batch {
  constructor(db) { this._db = db; this._ops = []; }
  set(ref, data, opts) { this._ops.push(() => ref.set(data, opts)); return this; }
  update(ref, data) { this._ops.push(() => ref.update(data)); return this; }
  delete(ref) { this._ops.push(() => ref.delete()); return this; }
  async commit() { for (const op of this._ops) await op(); }
}

class FakeDb {
  constructor() { this._docs = new Map(); this._writes = []; this._auto = 0; this._txnCount = 0; }
  collection(name) { return new CollRef(this, name); }
  batch() { return new Batch(this); }
  async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); }
  async runTransaction(fn) {
    this._txnCount++;
    const t = new Txn(this);
    const out = await fn(t);
    await t._commit();
    return out;
  }
  // ── Test helpers ────────────────────────────────────────────────
  seed(coll, id, data) { this._docs.set(`${coll}/${id}`, deepCopy(data)); return this; }
  read(coll, id) { const d = this._docs.get(`${coll}/${id}`); return d === undefined ? undefined : deepCopy(d); }
  has(coll, id) { return this._docs.has(`${coll}/${id}`); }
  all(coll) {
    const out = [];
    for (const [p, d] of this._docs) if (p.startsWith(`${coll}/`)) out.push({ id: p.split('/').pop(), data: deepCopy(d) });
    return out;
  }
}

module.exports = { FakeDb, Timestamp, FieldValue, deepCopy, applyUpdate, getPath };

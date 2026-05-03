// ── KV Store stub ──────────────────────────────────────────────────
// All data is now stored in Firebase Firestore client-side.
// This file is kept as a stub so the module reference still resolves.
// None of these functions are called by the email-only server.
// ──────────────────────────────────────────────────────────────────

export const set = async (_key: string, _value: any): Promise<void> => {};
export const get = async (_key: string): Promise<any> => null;
export const del = async (_key: string): Promise<void> => {};
export const mset = async (_keys: string[], _values: any[]): Promise<void> => {};
export const mget = async (_keys: string[]): Promise<any[]> => [];
export const mdel = async (_keys: string[]): Promise<void> => {};
export const getByPrefix = async (_prefix: string): Promise<any[]> => [];

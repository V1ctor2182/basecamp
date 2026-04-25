// Deep-merge: defaults provide structure for any keys missing in `loaded`.
// Plain-object values merge recursively; arrays/primitives in `loaded` replace
// defaults wholesale (so an explicit empty array from server stays empty).
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) &&
    Object.getPrototypeOf(v) === Object.prototype
}

export function deepMerge<T>(defaults: T, loaded: unknown): T {
  if (!isPlainObject(loaded)) return loaded === undefined ? defaults : (loaded as T)
  if (!isPlainObject(defaults)) return loaded as T
  const out: Record<string, unknown> = { ...defaults }
  for (const k of Object.keys(loaded)) {
    const dv = (defaults as Record<string, unknown>)[k]
    out[k] = isPlainObject(dv) && isPlainObject(loaded[k])
      ? deepMerge(dv, loaded[k])
      : loaded[k]
  }
  return out as T
}

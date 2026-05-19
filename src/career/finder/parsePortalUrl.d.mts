// Ambient types for the .mjs sibling. Lets Portals.tsx import these
// helpers under tsc strict mode without an inline `// @ts-expect-error`.

export type PortalType = 'greenhouse' | 'ashby' | 'lever' | 'github-md'

export type ParseResult =
  | { type: PortalType; config: Record<string, unknown> }
  | { error: string }

export function parsePortalUrl(input: string): ParseResult
export function buildPortalUrl(
  type: string | undefined,
  config: Record<string, unknown> | undefined | null,
): string | null

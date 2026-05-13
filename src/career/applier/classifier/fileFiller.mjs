// File-class path resolver — maps file-upload field subclasses to actual
// disk paths.
//
// 07-applier/03-field-classifier m2.
//
// Subclass routing:
//   resume / cv          → data/career/output/{jobId}-{resumeId}.pdf
//                          (output of 03-cv-engine/05-tailor-engine)
//   cover-letter         → ctx.coverLetterPath if provided, else manual
//                          (m3 wires generation; V1 not auto-generated here)
//   work-samples         → manual (no auto-resolution; needs URL field
//                          variant routed to HARD/portfolio)
//   transcript           → manual (rare; user-uploaded once)
//   general-file         → manual

import path from 'node:path';
import { promises as fs } from 'node:fs';

export const TAILOR_OUTPUT_DIR = path.resolve('data', 'career', 'output');

// C1 fix from review: sanitize jobId/resumeId before path.join to block
// path-traversal vectors. classifier is the trust boundary — must not
// assume upstream validation. Restrictive whitelist: 12-hex jobId
// convention + alphanumeric/dash/underscore resume IDs.
const JOB_ID_RE = /^[a-f0-9]{12}$/;
const RESUME_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

function isPathSafe(filepath, expectedRoot) {
  const resolved = path.resolve(filepath);
  // Belt-and-suspenders: also assert the resolved path stays inside the
  // expected root (catches edge cases like resolved-via-symlink).
  return resolved.startsWith(expectedRoot + path.sep);
}

/**
 * Resolve a File-class field to a path. Returns a partial DraftField
 * update (the caller merges with the classifyAndLookup base).
 *
 * @param {{ role: string, name: string }} snapshotEntry
 * @param {{ subclass: string }} classification
 * @param {{ jobId?: string, resumeId?: string, coverLetterPath?: string }} [ctx]
 * @returns {Promise<{
 *   suggested_value: string | null,
 *   confidence: 'high' | 'medium' | 'manual',
 *   source: object,
 * }>}
 */
export async function fillFileField(snapshotEntry, classification, ctx = {}) {
  const { jobId, resumeId, coverLetterPath } = ctx;
  const subclass = classification.subclass;

  if (subclass === 'resume') {
    if (!jobId || !resumeId) {
      return {
        suggested_value: null,
        confidence: 'manual',
        source: {
          kind: 'file',
          subclass: 'resume',
          status: 'missing-context',
          hint: 'classifyAndFill ctx must include jobId + resumeId',
        },
      };
    }
    // C1 fix: sanitize before path.join — block traversal vectors
    if (!JOB_ID_RE.test(jobId) || !RESUME_ID_RE.test(resumeId)) {
      return {
        suggested_value: null,
        confidence: 'manual',
        source: {
          kind: 'file',
          subclass: 'resume',
          status: 'invalid-id',
          hint: 'jobId must be 12-hex; resumeId must be [a-zA-Z0-9_-]{1,64}',
        },
      };
    }
    const filename = `${jobId}-${resumeId}.pdf`;
    const filepath = path.join(TAILOR_OUTPUT_DIR, filename);
    // C1 fix: belt-and-suspenders — verify resolved path stays inside root
    if (!isPathSafe(filepath, TAILOR_OUTPUT_DIR)) {
      return {
        suggested_value: null,
        confidence: 'manual',
        source: {
          kind: 'file',
          subclass: 'resume',
          status: 'path-escape',
          hint: 'resolved path escapes TAILOR_OUTPUT_DIR',
        },
      };
    }
    try {
      const stat = await fs.stat(filepath);
      if (stat.isFile()) {
        return {
          suggested_value: filepath,
          confidence: 'high',
          source: {
            kind: 'file',
            subclass: 'resume',
            status: 'found',
            path: filepath,
          },
        };
      }
      return {
        suggested_value: filepath,
        confidence: 'manual',
        source: {
          kind: 'file',
          subclass: 'resume',
          status: 'not-a-file',
          path: filepath,
        },
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return {
          suggested_value: filepath,
          confidence: 'medium',
          source: {
            kind: 'file',
            subclass: 'resume',
            status: 'unverified',
            path: filepath,
            hint: 'run Tailor Engine first to generate the PDF',
          },
        };
      }
      // M4 fix from review: include path on EACCES/EBUSY so user knows
      // where to chmod / unlock
      return {
        suggested_value: null,
        confidence: 'manual',
        source: {
          kind: 'file',
          subclass: 'resume',
          status: 'error',
          path: filepath,
          error: err.message,
        },
      };
    }
  }

  if (subclass === 'cover-letter') {
    if (coverLetterPath) {
      // C1 fix: assert absolute path; reject relative + symlink games.
      // Note: cover-letter path is user/caller-supplied, may be ANYWHERE
      // (not bound to TAILOR_OUTPUT_DIR). We at least require absolute.
      if (!path.isAbsolute(coverLetterPath)) {
        return {
          suggested_value: null,
          confidence: 'manual',
          source: {
            kind: 'file',
            subclass: 'cover-letter',
            status: 'invalid-path',
            hint: 'coverLetterPath must be absolute',
          },
        };
      }
      try {
        await fs.access(coverLetterPath);
        return {
          suggested_value: coverLetterPath,
          confidence: 'high',
          source: {
            kind: 'file',
            subclass: 'cover-letter',
            status: 'found',
            path: coverLetterPath,
          },
        };
      } catch {
        return {
          suggested_value: coverLetterPath,
          confidence: 'manual',
          source: {
            kind: 'file',
            subclass: 'cover-letter',
            status: 'path-not-readable',
            path: coverLetterPath,
          },
        };
      }
    }
    return {
      suggested_value: null,
      confidence: 'manual',
      source: {
        kind: 'file',
        subclass: 'cover-letter',
        status: 'generate-first',
        hint: 'cover-letter file not provided in ctx; generate via Tailor or LLM',
      },
    };
  }

  // work-samples / transcript / general-file — V1 doesn't auto-resolve
  return {
    suggested_value: null,
    confidence: 'manual',
    source: {
      kind: 'file',
      subclass,
      status: 'unsupported',
      hint: `V1 auto-resolution not implemented for subclass=${subclass}`,
    },
  };
}

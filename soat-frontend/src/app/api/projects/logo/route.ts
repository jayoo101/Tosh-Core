import { NextRequest, NextResponse } from 'next/server'
import { getSupabaseAdmin, SupabaseAdminUnavailable } from '../../../lib/supabaseAdmin'
import { applyCors, applyRateLimit, corsPreflight } from '../../../lib/apiGuard'
import { reportError } from '@/lib/observability'
import { LOGO_MAX_BYTES } from '@/lib/logoUpload'

export { LOGO_MAX_BYTES }

/**
 * `POST /api/projects/logo` — accepts token artwork and returns a URL.
 *
 * ── Why an upload and not just the URL field ───────────────────────────────
 *
 * `projects.logo_url` has always accepted a URL, so the capability looked like
 * it existed. It did not: a launcher had to already have somewhere to host an
 * image, and most do not, which is why the directory is mostly letter sigils.
 *
 * ── Where this sits in the launch flow, which is load bearing ──────────────
 *
 * It runs while the form is being filled, BEFORE the launch transaction.
 *
 * That is not a convenience. `launch/page.tsx` snapshots the form into `snap`
 * when the launch is submitted, and every consumer downstream reads that
 * snapshot: the optimistic `rememberProject` row, the `personal_sign`
 * attestation, and the `POST /api/projects` body. Because `logoUrl` is inside
 * the signed attestation, the URL has to be final before the signature is
 * produced — so uploading here and letting the existing state carry the result
 * means the attestation, the API route and the table need no changes at all.
 * An upload placed after the signature would have to re-sign to stay
 * consistent, and a mismatch there fails creator verification rather than
 * failing visibly.
 *
 * ── What authorises the caller, stated honestly ────────────────────────────
 *
 * Nothing does, and nothing can. At form-fill time there is no `txHash` and no
 * launch, so there is no creator to recover a signature against — the check
 * `POST /api/projects` performs is not available here, and demanding a wallet
 * signature just to attach a picture would add a third prompt to a flow that
 * already has two.
 *
 * So this is deliberately an unauthenticated endpoint, and the controls are
 * sized for that rather than pretending otherwise:
 *
 *   • a rate limit, shared-shape with the other routes;
 *   • a hard byte cap, enforced here AND on the bucket (migration 0003);
 *   • the real bytes sniffed, because `file.type` is client-controlled and a
 *     declared `image/png` proves nothing;
 *   • object names derived from a hash of the content, so the caller never
 *     chooses a path and the same image twice is the same object.
 *
 * The accepted cost is orphans: someone can upload and never launch, and that
 * object stays. Content addressing bounds it — the same bytes never occupy two
 * names — and 1 MiB against Supabase's quota makes the worst case a storage
 * bill rather than an outage. It is not free, and it is the price of not
 * putting a wallet prompt in front of choosing an image.
 *
 * ── Why SVG is refused ────────────────────────────────────────────────────
 *
 * An SVG is a document, not a bitmap. It can carry `<script>`, and it would be
 * served from the same storage domain as everything else in the bucket. No
 * token logo needs one, so the answer is no rather than a sanitiser we would
 * have to keep correct.
 */

const CORS_OPTS = { methods: ['POST', 'OPTIONS'] as const } as const

/** Tighter than `projects-post`: this one moves bytes, not a JSON row. */
const POST_RATE_LIMIT = {
  name: 'project-logo-post',
  capacity: 10,
  refillPerSec: 1,
} as const

const BUCKET = 'project-logos'
/** Size cap lives in `lib/logoUpload.ts` so the form can refuse before upload. */

/**
 * Magic-byte signatures, checked against the actual upload.
 *
 * Keyed by the extension the object is stored under, because the extension is
 * derived from what the bytes ARE and never from the filename the browser
 * offered. WebP needs two windows: `RIFF` at 0 and `WEBP` at 8, since `RIFF`
 * alone also matches WAV and AVI.
 */
const SIGNATURES: ReadonlyArray<{
  ext: string
  contentType: string
  match: (b: Uint8Array) => boolean
}> = [
  {
    ext: 'png',
    contentType: 'image/png',
    match: b => b.length > 8 &&
      b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 &&
      b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a,
  },
  {
    ext: 'jpg',
    contentType: 'image/jpeg',
    match: b => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  },
  {
    ext: 'gif',
    contentType: 'image/gif',
    match: b => b.length > 6 &&
      b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38,
  },
  {
    ext: 'webp',
    contentType: 'image/webp',
    match: b => b.length > 12 &&
      b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
]

function sniff(bytes: Uint8Array) {
  return SIGNATURES.find(s => s.match(bytes)) ?? null
}

/** Web Crypto rather than `node:crypto`, so the handler is runtime-agnostic. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer)
  return Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function OPTIONS(req: NextRequest) {
  return corsPreflight(req, CORS_OPTS)
}

export async function POST(req: NextRequest) {
  const limited = await applyRateLimit(req, POST_RATE_LIMIT)
  if (limited) return applyCors(limited, req, CORS_OPTS)

  const bad = (error: string, status = 422) =>
    applyCors(NextResponse.json({ error }, { status }), req, CORS_OPTS)

  /* `formData()` throws on a body that is not multipart, and nothing catches a
   * throw out of a handler — that would be a 500 for a client mistake. */
  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return bad('Send the image as multipart/form-data with a `file` field', 400)
  }

  const file = form.get('file')
  if (!(file instanceof Blob)) {
    return bad('No `file` field in the upload', 400)
  }

  /* Checked before reading the body into memory. `file.size` is the length the
   * browser reports for a Blob it already holds, so it is not a claim the way
   * `file.type` is, and refusing here avoids buffering the whole thing first. */
  if (file.size > LOGO_MAX_BYTES) {
    return bad(`That image is ${Math.ceil(file.size / 1024)} KB. The limit is ` +
      `${LOGO_MAX_BYTES / 1024} KB.`, 413)
  }
  if (file.size === 0) {
    return bad('That file is empty')
  }

  const bytes = new Uint8Array(await file.arrayBuffer())

  /* Re-checked against the bytes actually received, because the two can differ:
   * `size` came from the client and this did not. */
  if (bytes.byteLength > LOGO_MAX_BYTES) {
    return bad(`That image is over the ${LOGO_MAX_BYTES / 1024} KB limit.`, 413)
  }

  const kind = sniff(bytes)
  if (!kind) {
    /* Named separately because it is the one refusal a user is likely to hit on
     * purpose, and "unsupported image" would read as a bug to someone holding a
     * perfectly good logo. */
    const looksSvg = new TextDecoder().decode(bytes.subarray(0, 256)).trimStart()
    if (looksSvg.startsWith('<?xml') || looksSvg.startsWith('<svg')) {
      return bad('SVG is not accepted — it is a document rather than an image ' +
        'and can carry script. Export it as PNG.', 415)
    }
    return bad('That file is not a PNG, JPEG, GIF or WebP.', 415)
  }

  const path = `${await sha256Hex(bytes)}.${kind.ext}`

  let admin
  try {
    admin = getSupabaseAdmin()
  } catch (err) {
    if (err instanceof SupabaseAdminUnavailable) {
      return applyCors(
        NextResponse.json(
          { error: 'Image upload is not configured on this deployment' },
          { status: 503 },
        ),
        req,
        CORS_OPTS,
      )
    }
    throw err
  }

  /* `upsert` because the name IS the content: a second upload of the same image
   * is the same object, and failing it as a conflict would be reporting success
   * as an error. */
  const { error } = await admin.storage.from(BUCKET).upload(path, bytes, {
    contentType: kind.contentType,
    upsert: true,
  })

  if (error) {
    reportError(error, {
      surface: 'api-route',
      extra: { route: 'POST /api/projects/logo', path },
    })
    return applyCors(
      NextResponse.json({ error: 'Could not store that image' }, { status: 502 }),
      req,
      CORS_OPTS,
    )
  }

  const { data } = admin.storage.from(BUCKET).getPublicUrl(path)

  return applyCors(
    NextResponse.json({ url: data.publicUrl }, { status: 201 }),
    req,
    CORS_OPTS,
  )
}

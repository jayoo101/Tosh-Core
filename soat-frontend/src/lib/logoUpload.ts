/**
 * Shared limits for token artwork.
 *
 * The route enforces these against the bytes it actually received. The form
 * enforces them first so a 2 MB drop never leaves the browser. The two copies
 * of the number used to live on the route, and that file imports NextRequest
 * and the service-role client, so the form could not share them without
 * pulling the handler into the client bundle. This module is the seam.
 */

export const LOGO_MAX_BYTES = 1_048_576

/** The `accept` string a file input can use; the server still sniffs bytes. */
export const LOGO_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp'

export const LOGO_ENDPOINT = '/api/projects/logo'

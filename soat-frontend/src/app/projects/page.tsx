import { redirect } from 'next/navigation'

/** /projects → homepage Agent Directory anchor (MeritX has single directory on /). */
export default function ProjectsRedirect() {
  redirect('/#directory')
}

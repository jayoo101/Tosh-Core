import { redirect } from 'next/navigation'

/** The v1 directory. Launches are listed on /launchpad. */
export default function Page(): never {
  redirect('/launchpad')
}

import { redirect } from 'next/navigation'

/** The v1 launch form. Listing goes through the v2 form. */
export default function Page(): never {
  redirect('/launch/v2')
}

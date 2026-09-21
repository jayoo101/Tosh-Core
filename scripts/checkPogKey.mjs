// Does the PoG signing key you are about to deploy match the one the factory
// will check it against?
//
// The runbook calls this "verifiable only after the fact by registering once",
// and that was true of the deploy but is not true of the key: the factory's
// `pogSigner()` is a public read and the key's address is a local derivation,
// so the comparison `sign-allocation` makes at request time can be made here
// instead, before anyone spends gas on a `registerPoG` that cannot succeed.
//
// The key is read from POG_SIGNER_PRIVATE_KEY in the environment rather than
// from argv, and is never printed. Set it with a no-echo prompt so it does not
// reach shell history:
//
//   $k = Read-Host 'PoG private key' -AsSecureString
//   $env:POG_SIGNER_PRIVATE_KEY =
//     [Runtime.InteropServices.Marshal]::PtrToStringAuto(
//       [Runtime.InteropServices.Marshal]::SecureStringToBSTR($k))
//   node scripts/checkPogKey.mjs
//   Remove-Item Env:\POG_SIGNER_PRIVATE_KEY
import { createPublicClient, http, getAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const FACTORY = getAddress('0x20dE906A96FfB89BE6fd6267A0876A68017792F7')
const RPC = process.env.MONITOR_RPC || process.env.BSC_RPC || 'https://bsc-dataseed.bnbchain.org'

const raw = process.env.POG_SIGNER_PRIVATE_KEY
if (!raw) {
  console.error('POG_SIGNER_PRIVATE_KEY is not set. See the header of this file.')
  process.exit(2)
}

// Accept with or without 0x, the way the route's own loader does.
const pk = (raw.trim().startsWith('0x') ? raw.trim() : `0x${raw.trim()}`)

let account
try {
  account = privateKeyToAccount(pk)
} catch (e) {
  console.error(`That is not a usable private key: ${e.message}`)
  console.error('Nothing was sent anywhere; fix the value and re-run.')
  process.exit(2)
}

const client = createPublicClient({ chain: { id: 56, name: 'bsc', nativeCurrency: { name: 'BNB', symbol: 'BNB', decimals: 18 }, rpcUrls: { default: { http: [RPC] } } }, transport: http(RPC, { retryCount: 5 }) })

const onchain = await client.readContract({
  address: FACTORY,
  abi: [{ type: 'function', name: 'pogSigner', inputs: [], outputs: [{ type: 'address' }], stateMutability: 'view' }],
  functionName: 'pogSigner',
})

const derived = getAddress(account.address)
const expected = getAddress(onchain)
const ok = derived === expected

console.log('factory        ', FACTORY)
console.log('expects        ', expected)
console.log('your key gives ', derived)
console.log('')
console.log(ok
  ? 'MATCH. This is the key to put in Vercel as POG_SIGNER_PRIVATE_KEY.'
  : 'MISMATCH. Deploying this key leaves genesis deposits broken exactly as they are now.')

// `process.exit()` here aborted the process instead of exiting it: libuv still
// held the transport's socket, and tearing it down mid-flight tripped
// `!(handle->flags & UV_HANDLE_CLOSING)` and returned 0xC0000409 rather than
// the 0 or 1 this is supposed to report. Setting the code and letting the loop
// drain gives the same answer and actually delivers it.
process.exitCode = ok ? 0 : 1

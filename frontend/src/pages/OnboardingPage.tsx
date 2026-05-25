import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'

const API      = import.meta.env.VITE_ARC_API_URL ?? 'http://localhost:8000'
const FAUCET   = 'https://faucet.circle.com'
const EXPLORER = 'https://testnet.arcscan.app'

const ARC_CHAIN_PARAMS = {
  chainId:          '0x4CEF52',
  chainName:        'Arc Testnet',
  nativeCurrency:   { name: 'USDC', symbol: 'USDC', decimals: 6 },
  rpcUrls:          ['https://rpc-arc-testnet.circle.com'],
  blockExplorerUrls: ['https://testnet.arcscan.app'],
}

declare global {
  interface Window {
    ethereum?: {
      request:        (a: { method: string; params?: unknown[] }) => Promise<unknown>
      on:             (event: string, handler: (...args: unknown[]) => void) => void
      removeListener: (event: string, handler: (...args: unknown[]) => void) => void
    }
  }
}

type Mode = 'signin' | 'create'
type Step = 'form' | 'loading' | 'done'

interface WalletResult {
  address:    string
  balance_usdc: number
  business_id: string
  name:       string
  isNew:      boolean
}

export default function OnboardingPage() {
  const navigate = useNavigate()

  const [mode, setMode]   = useState<Mode>('signin')
  const [step, setStep]   = useState<Step>('form')
  const [name, setName]   = useState('')
  const [email, setEmail] = useState('')
  const [error, setError] = useState('')
  const [result, setResult] = useState<WalletResult | null>(null)
  const [web3Addr, setWeb3Addr] = useState<string>(
    () => localStorage.getItem('brewing_web3_wallet') || ''
  )
  const [web3Connecting, setWeb3Connecting] = useState(false)

  // If already have a session, go straight to dashboard
  useEffect(() => {
    const addr = localStorage.getItem('brewing_employer_address')
    if (addr) navigate('/dashboard')
  }, [navigate])

  const connectWallet = async () => {
    if (!window.ethereum) {
      alert('MetaMask is not installed. Add it at metamask.io first.')
      return
    }
    setWeb3Connecting(true)
    try {
      const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' }) as string[]
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: ARC_CHAIN_PARAMS.chainId }] })
      } catch (sw: unknown) {
        if ((sw as { code?: number }).code === 4902) {
          await window.ethereum.request({ method: 'wallet_addEthereumChain', params: [ARC_CHAIN_PARAMS] })
        }
      }
      const addr = accounts[0] ?? ''
      localStorage.setItem('brewing_web3_wallet', addr)
      // Use as employer address so auth guard passes
      localStorage.setItem('brewing_employer_address', addr)
      localStorage.setItem('brewing_employer_name', addr.slice(0, 8) + '…')
      setWeb3Addr(addr)
      navigate('/dashboard')
    } catch {
      // user rejected
    } finally {
      setWeb3Connecting(false)
    }
  }

  const reset = (newMode: Mode) => {
    setMode(newMode)
    setStep('form')
    setError('')
    setName('')
    setEmail('')
    setResult(null)
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!email.trim()) return
    if (mode === 'create' && !name.trim()) return
    setError('')
    setStep('loading')

    try {
      const endpoint = mode === 'signin' ? '/api/login' : '/api/onboard'
      const body     = mode === 'signin'
        ? { name: email.trim(), email: email.trim() }  // login only needs email; name is a dummy
        : { name: name.trim(), email: email.trim() }

      const res  = await fetch(`${API}${endpoint}`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })

      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.detail ?? 'Something went wrong')
      }

      const data = await res.json()

      // Persist session
      localStorage.setItem('brewing_employer_address', data.wallet_address)
      localStorage.setItem('brewing_employer_name',    data.name ?? name.trim())
      localStorage.setItem('brewing_business_id',      data.business_id)

      setResult({
        address:      data.wallet_address,
        balance_usdc: data.balance_usdc,
        business_id:  data.business_id,
        name:         data.name ?? name.trim(),
        isNew:        !data.existing,
      })
      setStep('done')
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Something went wrong')
      setStep('form')
    }
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">

      {/* Nav */}
      <nav className="border-b border-arc-border bg-black/90">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <button
            onClick={() => navigate('/')}
            className="font-mono font-bold text-sm tracking-[0.2em] hover:text-arc-green transition-colors"
          >
            BREWING
          </button>
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-arc-green pulse-dot" />
            <span className="font-mono text-[11px] text-arc-green">Arc Testnet Live</span>
          </div>
        </div>
      </nav>

      <main className="flex-1 flex items-center justify-center px-6 py-16">
        <div className="w-full max-w-md">

          {/* ── Form step ─────────────────────────────────────────────────── */}
          {step === 'form' && (
            <div className="flex flex-col gap-8">

              {/* MetaMask connect */}
              <div className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={connectWallet}
                  disabled={web3Connecting}
                  className="w-full border border-arc-border rounded-xl px-5 py-4 flex items-center gap-4 hover:border-arc-green transition-colors group disabled:opacity-50"
                >
                  <span className="text-2xl">🦊</span>
                  <div className="flex flex-col items-start gap-0.5">
                    <span className="font-mono text-sm font-semibold text-white group-hover:text-arc-green transition-colors">
                      {web3Connecting ? 'Connecting…' : 'Connect with MetaMask'}
                    </span>
                    <span className="font-mono text-[10px] text-arc-muted">Arc Testnet · instant access</span>
                  </div>
                </button>
                <div className="flex items-center gap-3">
                  <div className="flex-1 border-t border-arc-border" />
                  <span className="font-mono text-[10px] text-arc-muted">or sign in with email</span>
                  <div className="flex-1 border-t border-arc-border" />
                </div>
              </div>

              {/* Mode toggle */}
              <div className="flex flex-col gap-3">
                <h1 className="text-2xl font-bold">
                  {mode === 'signin' ? 'Welcome back.' : 'Create your account.'}
                </h1>
                <p className="font-mono text-[12px] text-arc-sub leading-relaxed">
                  {mode === 'signin'
                    ? 'Sign in with your email to access your dashboard and agent history.'
                    : 'Get a Circle-managed wallet on Arc Testnet and start hiring AI agents.'
                  }
                </p>

                {/* Tab switcher */}
                <div className="flex border border-arc-border rounded-lg overflow-hidden mt-1">
                  <button
                    type="button"
                    onClick={() => reset('signin')}
                    className={`flex-1 font-mono text-xs py-2.5 transition-colors ${
                      mode === 'signin'
                        ? 'bg-arc-green text-black font-semibold'
                        : 'text-arc-muted hover:text-white'
                    }`}
                  >
                    Sign In
                  </button>
                  <button
                    type="button"
                    onClick={() => reset('create')}
                    className={`flex-1 font-mono text-xs py-2.5 transition-colors ${
                      mode === 'create'
                        ? 'bg-arc-green text-black font-semibold'
                        : 'text-arc-muted hover:text-white'
                    }`}
                  >
                    Create Account
                  </button>
                </div>
              </div>

              <form onSubmit={handleSubmit} className="flex flex-col gap-4">

                {/* Name — only for create */}
                {mode === 'create' && (
                  <div className="flex flex-col gap-1.5">
                    <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">
                      Company / Name
                    </label>
                    <input
                      type="text"
                      value={name}
                      onChange={e => setName(e.target.value)}
                      placeholder="Acme Corp"
                      required
                      className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white placeholder-arc-muted focus:outline-none focus:border-arc-green transition-colors"
                    />
                  </div>
                )}

                <div className="flex flex-col gap-1.5">
                  <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">
                    Email
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="you@company.com"
                    required
                    autoFocus
                    className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white placeholder-arc-muted focus:outline-none focus:border-arc-green transition-colors"
                  />
                </div>

                {error && (
                  <div className="border border-red-500/20 rounded-lg px-4 py-3 bg-red-500/5 flex flex-col gap-1">
                    <span className="font-mono text-xs text-red-400">{error}</span>
                    {mode === 'signin' && error.includes('No account') && (
                      <button
                        type="button"
                        onClick={() => reset('create')}
                        className="font-mono text-[11px] text-arc-green hover:underline text-left mt-1"
                      >
                        Create an account instead →
                      </button>
                    )}
                  </div>
                )}

                <button
                  type="submit"
                  className="bg-arc-green text-black font-mono font-semibold text-sm px-6 py-3 rounded-lg hover:bg-emerald-400 transition-colors mt-2"
                >
                  {mode === 'signin' ? 'Sign In →' : 'Create Account →'}
                </button>
              </form>

              {/* Switch mode hint */}
              <p className="font-mono text-[11px] text-arc-muted text-center">
                {mode === 'signin'
                  ? <>No account yet?{' '}
                      <button onClick={() => reset('create')} className="text-arc-green hover:underline">
                        Create one
                      </button>
                    </>
                  : <>Already have an account?{' '}
                      <button onClick={() => reset('signin')} className="text-arc-green hover:underline">
                        Sign in
                      </button>
                    </>
                }
              </p>
            </div>
          )}

          {/* ── Loading step ───────────────────────────────────────────────── */}
          {step === 'loading' && (
            <div className="flex flex-col items-center gap-6 text-center">
              <div className="w-12 h-12 border-2 border-arc-green border-t-transparent rounded-full animate-spin" />
              <div className="flex flex-col gap-2">
                <div className="font-mono text-[10px] text-arc-muted tracking-widest">
                  {mode === 'signin' ? 'SIGNING IN' : 'PROVISIONING WALLET'}
                </div>
                <p className="font-mono text-sm text-arc-sub">
                  {mode === 'signin' ? 'Looking up your account…' : 'Creating your Circle DCW on Arc Testnet…'}
                </p>
              </div>
              {mode === 'create' && (
                <div className="border border-arc-border rounded-xl bg-arc-surface p-5 w-full text-left flex flex-col gap-2">
                  {[
                    '✓ Connecting to Circle MPC',
                    '✓ Generating Arc L1 wallet',
                    '⟳ Registering on-chain…',
                  ].map((line, i) => (
                    <div
                      key={i}
                      className={`font-mono text-[11px] ${line.startsWith('✓') ? 'text-arc-green' : 'text-arc-sub'}`}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* ── Done step ─────────────────────────────────────────────────── */}
          {step === 'done' && result && (
            <div className="flex flex-col gap-6">
              <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-bold">
                  {result.isNew
                    ? <>Account created <span className="text-arc-green">✓</span></>
                    : <>Welcome back, {result.name} <span className="text-arc-green">✓</span></>
                  }
                </h1>
                {!result.isNew && (
                  <p className="font-mono text-[12px] text-arc-sub">Your wallet and task history are ready.</p>
                )}
              </div>

              <div className="border border-arc-green/20 rounded-xl bg-arc-green/5 p-5 flex flex-col gap-3">
                <div className="flex flex-col gap-1">
                  <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase">Your Arc Wallet</div>
                  <div className="font-mono text-xs text-white break-all">{result.address}</div>
                </div>
                <div className="flex items-center justify-between border-t border-arc-green/10 pt-3">
                  <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase">USDC Balance</div>
                  <div className="font-mono text-lg font-bold text-arc-green">{result.balance_usdc.toFixed(4)} USDC</div>
                </div>
              </div>

              {result.isNew && result.balance_usdc === 0 && (
                <div className="border border-arc-border rounded-xl bg-arc-surface p-5 flex flex-col gap-3">
                  <div className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Fund Your Wallet</div>
                  <p className="font-mono text-[11px] text-arc-sub leading-relaxed">
                    Get 20 free USDC from the Circle testnet faucet to start posting tasks.
                  </p>
                  <div className="font-mono text-[10px] text-arc-muted border border-arc-border rounded px-3 py-2 bg-black break-all">
                    {result.address}
                  </div>
                  <a
                    href={FAUCET}
                    target="_blank"
                    rel="noreferrer"
                    className="border border-arc-border font-mono text-xs px-4 py-2.5 rounded-lg text-arc-sub hover:border-arc-green hover:text-arc-green transition-colors text-center"
                  >
                    Open Circle Faucet ↗
                  </a>
                  <a
                    href={`${EXPLORER}/address/${result.address}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-[10px] text-arc-muted hover:text-arc-green transition-colors text-center"
                  >
                    View on ArcScan ↗
                  </a>
                </div>
              )}

              <button
                onClick={() => navigate('/dashboard')}
                className="bg-arc-green text-black font-mono font-semibold text-sm px-6 py-3 rounded-lg hover:bg-emerald-400 transition-colors"
              >
                Go to Dashboard →
              </button>
            </div>
          )}

        </div>
      </main>
    </div>
  )
}

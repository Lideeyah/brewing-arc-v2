import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

const API = import.meta.env.VITE_ARC_API_URL ?? 'http://localhost:8000'

const ALL_CAPS = [
  { id: 'research',  label: 'Research' },
  { id: 'analysis',  label: 'Analysis' },
  { id: 'writing',   label: 'Writing' },
  { id: 'data',      label: 'Data' },
  { id: 'strategy',  label: 'Strategy' },
  { id: 'coding',    label: 'Coding' },
  { id: 'legal',     label: 'Legal' },
  { id: 'finance',   label: 'Finance' },
]

export default function RegisterAgentPage() {
  const navigate = useNavigate()

  const [name,         setName]         = useState('')
  const [description,  setDesc]         = useState('')
  const [price,        setPrice]        = useState('0.033')
  const [walletAddr,   setWallet]       = useState('')
  const [webhookUrl,   setWebhook]      = useState('')
  const [caps,         setCaps]         = useState<string[]>([])
  const [submitting,   setSub]          = useState(false)
  const [done,         setDone]         = useState(false)
  const [error,        setError]        = useState('')

  const toggleCap = (id: string) =>
    setCaps(prev => prev.includes(id) ? prev.filter(c => c !== id) : [...prev, id])

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim() || !walletAddr.trim() || caps.length === 0) return
    setSub(true); setError('')
    try {
      const res = await fetch(`${API}/api/agents/register`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:           name.trim(),
          description:    description.trim(),
          capabilities:   caps,
          payment_addr:   walletAddr.trim(),
          price_per_task: parseFloat(price) || 0.033,
          webhook_url:    webhookUrl.trim(),
        }),
      })
      if (!res.ok) {
        const d = await res.json()
        throw new Error(d.detail ?? 'Registration failed')
      }
      setDone(true)
    } catch (err: unknown) {
      setError((err as Error).message)
    } finally {
      setSub(false)
    }
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">

      {/* Nav */}
      <nav className="border-b border-arc-border bg-black/90 sticky top-0 z-50 backdrop-blur-md">
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

      <main className="flex-1 flex items-start justify-center px-6 py-16">
        <div className="w-full max-w-lg">

          {done ? (
            <div className="flex flex-col gap-6">
              <div className="border border-arc-green/20 rounded-xl bg-arc-green/5 p-8 flex flex-col gap-4 text-center">
                <div className="text-arc-green text-3xl">✓</div>
                <h1 className="font-mono text-xl font-bold text-white">Agent Listed</h1>
                <p className="font-mono text-[12px] text-arc-sub leading-relaxed">
                  <strong className="text-white">{name}</strong> is now live in the Brewing marketplace.
                  Businesses can hire it immediately.
                </p>
                <div className="flex gap-3 justify-center mt-2">
                  <button
                    onClick={() => navigate('/dashboard')}
                    className="bg-arc-green text-black font-mono font-semibold text-xs px-6 py-2.5 rounded-lg hover:bg-emerald-400 transition-colors"
                  >
                    View Marketplace →
                  </button>
                  <button
                    onClick={() => { setDone(false); setName(''); setDesc(''); setWallet(''); setWebhook(''); setCaps([]) }}
                    className="border border-arc-border font-mono text-xs px-6 py-2.5 rounded-lg text-arc-sub hover:border-arc-green hover:text-arc-green transition-colors"
                  >
                    List Another
                  </button>
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col gap-8">

              <div>
                <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase mb-2">OPEN AGENT MARKETPLACE</div>
                <h1 className="text-2xl font-bold mb-2">List Your Agent</h1>
                <p className="font-mono text-[12px] text-arc-sub leading-relaxed">
                  Any developer can list an agent on Brewing. Businesses hire it. Payment goes directly
                  to your Arc wallet — locked in escrow, released on delivery.
                </p>
              </div>

              <form onSubmit={submit} className="flex flex-col gap-5">

                <div className="flex flex-col gap-1.5">
                  <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Agent Name</label>
                  <input
                    type="text"
                    value={name}
                    onChange={e => setName(e.target.value)}
                    placeholder="e.g. LegalBot, DataBot, ContentBot"
                    required
                    className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white placeholder-arc-muted focus:outline-none focus:border-arc-green transition-colors"
                  />
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Description</label>
                  <textarea
                    value={description}
                    onChange={e => setDesc(e.target.value)}
                    placeholder="What does your agent do? What makes it better than alternatives?"
                    rows={3}
                    className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white placeholder-arc-muted focus:outline-none focus:border-arc-green transition-colors resize-none"
                  />
                </div>

                <div className="flex flex-col gap-2">
                  <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">
                    Capabilities <span className="normal-case tracking-normal text-arc-muted">(select all that apply)</span>
                  </label>
                  <div className="flex flex-wrap gap-2">
                    {ALL_CAPS.map(cap => (
                      <button
                        key={cap.id}
                        type="button"
                        onClick={() => toggleCap(cap.id)}
                        className={`font-mono text-[11px] px-3 py-1.5 rounded-lg border transition-colors ${
                          caps.includes(cap.id)
                            ? 'bg-arc-green/10 border-arc-green text-arc-green'
                            : 'border-arc-border text-arc-muted hover:border-arc-green/50 hover:text-arc-sub'
                        }`}
                      >
                        {cap.label}
                      </button>
                    ))}
                  </div>
                  {caps.length === 0 && (
                    <span className="font-mono text-[10px] text-arc-muted">Select at least one capability</span>
                  )}
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Price Per Task (USDC)</label>
                  <input
                    type="number"
                    min="0.001"
                    step="0.001"
                    value={price}
                    onChange={e => setPrice(e.target.value)}
                    className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white focus:outline-none focus:border-arc-green transition-colors"
                  />
                  <span className="font-mono text-[10px] text-arc-muted">Paid in USDC directly to your Arc wallet on task completion</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Arc Wallet Address</label>
                  <input
                    type="text"
                    value={walletAddr}
                    onChange={e => setWallet(e.target.value)}
                    placeholder="0x…"
                    required
                    className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white placeholder-arc-muted focus:outline-none focus:border-arc-green transition-colors"
                  />
                  <span className="font-mono text-[10px] text-arc-muted">USDC payments are sent to this address via AgentEscrow on Arc L1</span>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">
                    Webhook URL
                  </label>
                  <input
                    type="url"
                    value={webhookUrl}
                    onChange={e => setWebhook(e.target.value)}
                    placeholder="https://your-agent.com/webhook"
                    required
                    className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white placeholder-arc-muted focus:outline-none focus:border-arc-green transition-colors"
                  />
                  <span className="font-mono text-[10px] text-arc-muted">
                    Brewing POSTs tasks to this URL.{' '}
                    <a href="/docs" className="text-arc-green hover:underline">Read the webhook docs →</a>
                  </span>
                </div>

                {error && (
                  <div className="border border-red-500/20 rounded-lg px-4 py-3 bg-red-500/5">
                    <span className="font-mono text-xs text-red-400">{error}</span>
                  </div>
                )}

                <button
                  type="submit"
                  disabled={submitting || !name.trim() || !walletAddr.trim() || !webhookUrl.trim() || caps.length === 0}
                  className={`font-mono font-semibold text-sm px-6 py-3 rounded-lg transition-all ${
                    submitting || !name.trim() || !walletAddr.trim() || !webhookUrl.trim() || caps.length === 0
                      ? 'bg-arc-surface border border-arc-border text-arc-muted cursor-not-allowed'
                      : 'bg-arc-green text-black hover:bg-emerald-400'
                  }`}
                >
                  {submitting ? '⟳ Registering…' : 'List Agent on Brewing →'}
                </button>
              </form>

              <div className="border border-arc-border/50 rounded-xl p-5 bg-arc-surface/50 flex flex-col gap-2">
                <div className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">How Agent Payment Works</div>
                <div className="flex flex-col gap-1.5 mt-1">
                  {[
                    'Business posts a task and locks USDC in escrow',
                    'Your agent receives the task and delivers results',
                    'Smart contract releases USDC to your wallet automatically',
                    'Reputation score grows with each successful delivery',
                  ].map((s, i) => (
                    <div key={i} className="flex items-start gap-2 font-mono text-[11px] text-arc-sub">
                      <span className="text-arc-green flex-shrink-0">→</span>
                      <span>{s}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  )
}

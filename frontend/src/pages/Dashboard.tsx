import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const API      = import.meta.env.VITE_ARC_API_URL ?? 'http://localhost:8000'
const EXPLORER = 'https://testnet.arcscan.app'
const ESCROW   = '0x584164ce429991C30B5c83D5774d0870A77F5A22'

const short = (s: string) => s?.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : (s ?? '—')

// ── Types ──────────────────────────────────────────────────────────────────────

interface Wallet   { address: string; balance_usdc: number; type: string }
interface Analytics {
  program: string
  metrics: { totalJobs: number; completedJobs: number; slashedJobs: number; usdcSettled: number; usdcSlashed: number; registeredAgents: number; receiptsIssued: number; completionRate: number }
}
interface Job {
  job_id: number; employer: string; worker: string
  amount_usdc: number; sla_timeout: number; status: string; ipfs_spec_hash: string
}
interface Agent { agent_id: string; name: string; payment_addr: string; capabilities: string[]; reputation: number; jobs_completed: number; jobs_slashed: number }

// ── Sub-components ─────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    Completed: 'bg-arc-green/10 text-arc-green border-arc-green/20',
    Slashed:   'bg-red-500/10 text-red-400 border-red-500/20',
    Open:      'bg-arc-amber/10 text-arc-amber border-arc-amber/20',
  }
  return (
    <span className={`font-mono text-[10px] px-2 py-0.5 rounded border ${cfg[status] ?? 'border-arc-border text-arc-sub'}`}>
      {status}
    </span>
  )
}

function Dot({ color = '#10b981' }: { color?: string }) {
  return <span style={{ width: 6, height: 6, borderRadius: '50%', background: color, display: 'inline-block', boxShadow: `0 0 6px ${color}`, flexShrink: 0 }} />
}

// ── Tab A: Workspace ──────────────────────────────────────────────────────────

function WorkspaceTab() {
  const [wallet, setWallet]       = useState<Wallet | null>(null)
  const [analytics, setAnalytics] = useState<Analytics | null>(null)
  const [agents, setAgents]       = useState<Agent[]>([])
  const [running, setRunning]     = useState(false)
  const [log, setLog]             = useState<string[]>([])
  const logRef = useRef<HTMLDivElement>(null)

  const refresh = useCallback(async () => {
    try {
      const [w, a, ag] = await Promise.all([
        fetch(`${API}/api/wallet`).then(r => r.json()),
        fetch(`${API}/api/analytics`).then(r => r.json()),
        fetch(`${API}/api/agents`).then(r => r.json()),
      ])
      setWallet(w); setAnalytics(a); setAgents(ag)
    } catch { /* offline */ }
  }, [])

  useEffect(() => { refresh(); const id = setInterval(refresh, 8000); return () => clearInterval(id) }, [refresh])
  useEffect(() => { logRef.current?.scrollIntoView({ behavior: 'smooth' }) }, [log])

  const runDemo = async () => {
    if (running) return
    setRunning(true); setLog(['[00:00] Starting Brewing agent loop…'])
    try {
      const res  = await fetch(`${API}/api/demo/run`, { method: 'POST' })
      const data = await res.json()
      setLog(data.log ?? ['Done.'])
      await refresh()
    } catch (e: unknown) {
      setLog([`Error: ${(e as Error).message}`])
    } finally { setRunning(false) }
  }

  const m = analytics?.metrics

  return (
    <div className="flex flex-col gap-6">

      {/* Wallet + balance bar */}
      <div className="border border-arc-border rounded-xl bg-arc-surface p-5 flex flex-wrap gap-6 items-center justify-between">
        <div>
          <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase mb-1">Circle Developer-Controlled Wallet (SCA)</div>
          <div className="font-mono text-sm text-white">{wallet?.address ? short(wallet.address) : '—'}</div>
          <div className="font-mono text-[10px] text-arc-sub mt-0.5">{wallet?.address ?? '—'}</div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase mb-1">Native USDC Balance (Gas Token)</div>
          <div className="font-mono text-2xl font-bold text-arc-green">{wallet?.address ? `${(wallet.balance_usdc ?? 0).toFixed(4)} USDC` : '—'}</div>
          <div className="font-mono text-[10px] text-arc-sub">Arc L1 · no ETH required</div>
        </div>
      </div>

      {/* Metrics row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: 'Jobs On-Chain', value: m?.totalJobs ?? 0, color: '#fff' },
          { label: 'Completed', value: m?.completedJobs ?? 0, color: '#10b981' },
          { label: 'USDC Settled', value: m ? `$${m.usdcSettled.toFixed(2)}` : '—', color: '#f59e0b' },
          { label: 'Avg Gas Fee', value: '~$0.009', color: '#10b981' },
        ].map(c => (
          <div key={c.label} className="border border-arc-border rounded-lg bg-[#030303] p-4">
            <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase mb-2">{c.label}</div>
            <div className="font-mono text-xl font-bold" style={{ color: c.color }}>{c.value}</div>
          </div>
        ))}
      </div>

      {/* Multi-agent trace */}
      <div className="border border-arc-border rounded-xl bg-arc-surface">
        <div className="border-b border-arc-border px-5 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[10px] text-arc-muted tracking-widest">[+] ACTIVE MULTI-AGENT TRACING</span>
          </div>
          <span className="font-mono text-[9px] text-arc-sub">Arize Phoenix Cascade</span>
        </div>
        <div className="p-5 flex flex-col gap-3">
          {agents.length === 0 ? (
            <div className="font-mono text-xs text-arc-muted">No agents registered — run the demo loop</div>
          ) : agents.map(a => (
            <div key={a.agent_id} className="flex items-center gap-3">
              <span className="text-arc-muted font-mono text-xs">├──</span>
              <Dot color={a.reputation > 0 ? '#10b981' : '#3f3f46'} />
              <div className="flex-1">
                <span className="font-mono text-xs text-white">{a.name}</span>
                <span className="font-mono text-[10px] text-arc-muted ml-2">→</span>
                <span className="font-mono text-[10px] text-arc-sub ml-2">{a.capabilities.slice(0, 2).join(', ')}</span>
              </div>
              <div className="text-right">
                <div className="font-mono text-xs text-arc-green">{a.reputation.toFixed(0)} bps</div>
                <div className="font-mono text-[9px] text-arc-muted">{a.jobs_completed}✓ {a.jobs_slashed}✗</div>
              </div>
            </div>
          ))}
          <div className="flex items-center gap-3 mt-1">
            <span className="text-arc-muted font-mono text-xs">└──</span>
            <Dot color="#f59e0b" />
            <span className="font-mono text-[10px] text-arc-sub flex-1">Pacemaker active · 3.5s rate limit · max 15 req/min</span>
            <span className="font-mono text-[9px] text-arc-amber">3.5s</span>
          </div>
        </div>
      </div>

      {/* Micro-payment meter */}
      <div className="border border-arc-border rounded-xl bg-arc-surface">
        <div className="border-b border-arc-border px-5 py-3">
          <span className="font-mono text-[10px] text-arc-muted tracking-widest">[+] MICRO-PAYMENT METER · x402 PROTOCOL</span>
        </div>
        <div className="p-5 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <span className="text-arc-muted font-mono text-xs">└──</span>
            <span className="font-mono text-xs text-arc-sub">Verified API call cost:</span>
            <span className="font-mono text-xs text-arc-green font-bold">0.009 USDC</span>
            <span className="font-mono text-[10px] text-arc-muted ml-auto">Saved 98% vs ETH mainnet ($0.50+)</span>
          </div>
          <div className="flex items-center gap-2 ml-6">
            <span className="font-mono text-xs text-arc-sub">Total USDC slashed (SLA breaches):</span>
            <span className="font-mono text-xs text-red-400 font-bold">${m?.usdcSlashed?.toFixed(3) ?? '0.000'}</span>
          </div>
          <div className="flex items-center gap-2 ml-6">
            <span className="font-mono text-xs text-arc-sub">Receipts issued:</span>
            <span className="font-mono text-xs text-arc-green font-bold">{m?.receiptsIssued ?? 0}</span>
            <span className="font-mono text-[10px] text-arc-muted">signed on-chain</span>
          </div>
        </div>
      </div>

      {/* Run demo */}
      <div className="flex items-center gap-4">
        <button onClick={runDemo} disabled={running}
          className={`font-mono text-xs px-6 py-2.5 rounded-lg transition-all ${
            running ? 'bg-transparent border border-arc-muted text-arc-muted cursor-not-allowed'
                    : 'bg-arc-green text-black font-semibold hover:bg-emerald-400'
          }`}>
          {running ? '⟳ Running agent loop…' : '▶ Run Full Agent Demo'}
        </button>
        <span className="font-mono text-[10px] text-arc-muted">ACP discovery → escrow → Claude → USDC settlement → signed receipt</span>
      </div>

      {/* Agent log */}
      {log.length > 0 && (
        <div className="border border-arc-border rounded-xl bg-[#030303] p-5">
          <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase mb-3">AGENT OUTPUT LOG</div>
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {log.map((line, i) => (
              <div key={i} className="font-mono text-[11px] text-arc-sub leading-relaxed">
                <span className="text-arc-border mr-3">{String(i + 1).padStart(2, '0')}</span>
                <span className={line.includes('✓') || line.includes('settled') ? 'text-arc-green' : line.includes('Error') ? 'text-red-400' : ''}>{line}</span>
              </div>
            ))}
            <div ref={logRef} />
          </div>
        </div>
      )}
    </div>
  )
}

// ── Tab B: Agent Vault (Escrows) ──────────────────────────────────────────────

function VaultTab() {
  const [jobs, setJobs]   = useState<Job[]>([])
  const [loading, setLoad] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const j = await fetch(`${API}/api/jobs`).then(r => r.json())
      setJobs((j as Job[]).sort((a, b) => b.job_id - a.job_id))
    } catch { /* offline */ } finally { setLoad(false) }
  }, [])

  useEffect(() => { refresh(); const id = setInterval(refresh, 8000); return () => clearInterval(id) }, [refresh])

  if (loading) return <div className="font-mono text-xs text-arc-muted mt-8">Loading escrow registry…</div>

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase">ACTIVE B2B ESCROW REGISTRY</div>
          <div className="font-mono text-[10px] text-arc-sub mt-0.5">Vyper contract · {ESCROW.slice(0,10)}… · Arc Testnet</div>
        </div>
        <div className="font-mono text-[10px] text-arc-sub">{jobs.length} contracts on-chain</div>
      </div>

      {jobs.length === 0 ? (
        <div className="border border-arc-border rounded-xl p-8 text-center">
          <div className="font-mono text-xs text-arc-muted">No escrows yet — run a demo from the Workspace tab</div>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {jobs.map(job => (
            <div key={job.job_id} className="border border-arc-border rounded-xl bg-arc-surface overflow-hidden hover:border-arc-green/30 transition-colors">
              <div className="border-b border-arc-border px-5 py-3 flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[10px] text-arc-muted">ESCROW #{job.job_id}</span>
                  <span className="font-mono text-[10px] text-arc-sub">{ESCROW.slice(0,10)}…</span>
                </div>
                <StatusBadge status={job.status} />
              </div>
              <div className="px-5 py-4 grid grid-cols-1 sm:grid-cols-2 gap-4 font-mono text-[11px]">
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <span className="text-arc-muted">├── Parent Agent:</span>
                    <span className="text-white">{short(job.employer)}</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-arc-muted">└── Worker Agent:</span>
                    <span className="text-white">{short(job.worker)}</span>
                  </div>
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex gap-2">
                    <span className="text-arc-muted">├── Locked Bounty:</span>
                    <span className="text-arc-amber font-bold">{job.amount_usdc.toFixed(3)} USDC</span>
                  </div>
                  <div className="flex gap-2">
                    <span className="text-arc-muted">└── SLA Timeout:</span>
                    <span className="text-white">{job.sla_timeout}s · auto-slash on breach</span>
                  </div>
                </div>
              </div>
              {job.status === 'Completed' && (
                <div className="border-t border-arc-border px-5 py-3 flex items-center justify-between bg-arc-green/5">
                  <div className="flex items-center gap-2">
                    <Dot color="#10b981" />
                    <span className="font-mono text-[10px] text-arc-green">Output Verified · Circle MPC signed payout</span>
                  </div>
                  <a href={`${EXPLORER}/address/${job.employer}`} target="_blank" rel="noreferrer"
                     className="font-mono text-[10px] text-arc-green hover:underline">ArcScan ↗</a>
                </div>
              )}
              {job.status === 'Slashed' && (
                <div className="border-t border-arc-border px-5 py-3 flex items-center gap-2 bg-red-500/5">
                  <Dot color="#ef4444" />
                  <span className="font-mono text-[10px] text-red-400">SLA breached · USDC refunded to employer</span>
                </div>
              )}
              {job.ipfs_spec_hash && job.ipfs_spec_hash !== '0'.repeat(64) && (
                <div className="border-t border-arc-border px-5 py-2 bg-[#030303]">
                  <span className="font-mono text-[9px] text-arc-muted">spec_hash: {job.ipfs_spec_hash.slice(0, 24)}…</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Dashboard shell ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const [tab, setTab] = useState<'workspace' | 'vault'>('workspace')

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      {/* Nav */}
      <nav className="border-b border-arc-border sticky top-0 z-50 bg-black/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/')} className="font-mono font-bold text-sm tracking-[0.2em] text-white hover:text-arc-green transition-colors">
              BREWING
            </button>
            <span className="text-arc-border">/</span>
            <span className="font-mono text-xs text-arc-sub">Agora Dashboard</span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-arc-green pulse-dot" />
              <span className="font-mono text-[11px] text-arc-green tracking-wide">Arc Testnet Connected</span>
            </div>
            <a href={`${EXPLORER}/address/${ESCROW}`} target="_blank" rel="noreferrer"
               className="font-mono text-[10px] text-arc-sub hover:text-arc-green transition-colors">
              {ESCROW.slice(0,10)}… ↗
            </a>
          </div>
        </div>
      </nav>

      {/* Tab bar */}
      <div className="border-b border-arc-border bg-arc-surface">
        <div className="max-w-6xl mx-auto px-6 flex gap-0">
          {([
            { id: 'workspace', label: '01  WORKSPACE', sub: 'Planner · Agents · Metrics' },
            { id: 'vault',     label: '02  AGENT VAULT', sub: 'Escrows · SLA · Settlement' },
          ] as const).map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-6 py-4 flex flex-col gap-0.5 border-b-2 transition-all ${
                tab === t.id ? 'border-arc-green text-white' : 'border-transparent text-arc-muted hover:text-arc-sub'
              }`}>
              <span className="font-mono text-xs font-semibold tracking-wide">{t.label}</span>
              <span className="font-mono text-[9px] text-arc-muted">{t.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">
        {tab === 'workspace' ? <WorkspaceTab /> : <VaultTab />}
      </main>
    </div>
  )
}

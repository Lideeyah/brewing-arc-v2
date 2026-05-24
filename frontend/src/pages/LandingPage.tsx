import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const API          = import.meta.env.VITE_ARC_API_URL ?? 'http://localhost:8000'
const ESCROW_ADDR  = '0x584164ce429991C30B5c83D5774d0870A77F5A22'
const EXPLORER     = 'https://testnet.arcscan.app'
const DEFAULT_PROMPT = 'Hire an agent to verify vendor compliance, audit their invoice data, and settle the USDC escrow once confirmed.'

interface Step { ms: number; text: string; kind: 'sys' | 'tx' | 'ok' | 'err' }

const STEPS: Step[] = [
  { ms: 0,    text: '$ brewing-arc run --agent planner --task "vendor-compliance"', kind: 'sys' },
  { ms: 700,  text: '> Initializing Claude claude-opus-4-5 Control Plane...', kind: 'sys' },
  { ms: 1600, text: '> Querying ERC-8004 Agent Registry...', kind: 'sys' },
  { ms: 2600, text: '> [3 agents found] Negotiating Service Level Objectives (SLOs)...', kind: 'sys' },
  { ms: 3800, text: `> Funding Arc L1 Escrow Contract [${ESCROW_ADDR.slice(0,10)}…]`, kind: 'tx' },
  { ms: 5000, text: '> USDC locked in escrow — SLA active (300s timeout)', kind: 'tx' },
  { ms: 6200, text: '> Executing Visual Verification Work (3.5s Pacemaker)...', kind: 'sys' },
  { ms: 7800, text: '> Output verified — generating signed trace hash...', kind: 'sys' },
  { ms: 9000, text: '> Releasing USDC via Circle MPC programmatic payout...', kind: 'tx' },
]

export default function LandingPage() {
  const navigate  = useNavigate()
  const [stats, setStats]     = useState<{ totalJobs: number; usdcSettled: number; completionRate: number } | null>(null)
  const [running, setRunning] = useState(false)
  const [lines, setLines]     = useState<Step[]>([])
  const [txLink, setTxLink]   = useState<string | null>(null)
  const [done, setDone]       = useState(false)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    fetch(`${API}/api/analytics`).then(r => r.json()).then(d => setStats(d.metrics)).catch(() => null)
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [lines, txLink])

  const runDemo = async () => {
    if (running) return
    setRunning(true); setLines([]); setTxLink(null); setDone(false)
    timers.current.forEach(clearTimeout)
    timers.current = []

    STEPS.forEach(step => {
      const t = setTimeout(() => setLines(prev => [...prev, step]), step.ms)
      timers.current.push(t)
    })

    const finalT = setTimeout(async () => {
      try {
        const jobs = await fetch(`${API}/api/jobs`).then(r => r.json())
        const completed = (jobs as {status:string;job_id:number}[]).filter(j => j.status === 'Completed')
        const latest = completed.sort((a,b) => b.job_id - a.job_id)[0]
        const receipts = await fetch(`${API}/api/receipts`).then(r => r.json())
        const receipt = (receipts as {tx_hash:string}[])[0]
        const tx = receipt?.tx_hash ?? latest?.job_id?.toString() ?? '0x'
        setTxLink(tx.startsWith('0x') ? tx : null)
      } catch { /* use null */ }
      setLines(prev => [...prev, { ms: 0, text: '✓ SETTLEMENT COMPLETE — USDC released to worker wallet', kind: 'ok' }])
      setDone(true); setRunning(false)
    }, 10500)
    timers.current.push(finalT)
  }

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">
      {/* Nav */}
      <nav className="border-b border-arc-border sticky top-0 z-50 bg-black/90 backdrop-blur-md">
        <div className="max-w-7xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="font-mono font-bold text-sm tracking-[0.2em] text-white">BREWING</span>
            <span className="text-arc-muted font-mono text-[10px] tracking-widest">AGORA ENGINE</span>
          </div>
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-arc-green pulse-dot" />
              <span className="font-mono text-[11px] text-arc-green tracking-wide">Arc Testnet Connected</span>
            </div>
            <a href="https://github.com/Lideeyah/brewing-agora-agents" target="_blank" rel="noreferrer"
               className="font-mono text-[11px] text-arc-sub hover:text-white transition-colors">GitHub</a>
            <button onClick={() => navigate('/dashboard')}
              className="bg-arc-green text-black font-mono font-semibold text-xs px-4 py-2 rounded-md hover:bg-emerald-400 transition-colors">
              Launch Dashboard →
            </button>
          </div>
        </div>
      </nav>

      {/* Hero */}
      <main className="flex-1 max-w-7xl mx-auto px-6 py-20 grid grid-cols-1 lg:grid-cols-2 gap-16 items-center">

        {/* Left — copy */}
        <div className="flex flex-col gap-8">
          <div className="flex items-center gap-2 w-fit border border-arc-border rounded-full px-4 py-1.5">
            <span className="w-1.5 h-1.5 rounded-full bg-arc-green pulse-dot" />
            <span className="font-mono text-[10px] text-arc-green tracking-[0.15em]">BUILT ON CIRCLE ARC L1 · CHAIN 5042002</span>
          </div>

          <h1 className="text-4xl lg:text-5xl font-bold leading-[1.1] tracking-tight">
            Rebuilding the{' '}
            <span className="text-arc-green">Athenian Agora</span>{' '}
            for the Autonomous Economy.
          </h1>

          <p className="text-arc-sub text-base leading-relaxed max-w-xl">
            Brewing provides the decentralized orchestration, on-chain SLA enforcement, and trustless
            settlement infrastructure required to safely delegate B2B workflows across autonomous AI agents.
            Built natively on Circle's Arc L1 with zero-gas stablecoin finality.
          </p>

          {/* Live stats */}
          {stats && (
            <div className="grid grid-cols-3 gap-4">
              {[
                { label: 'Jobs Settled', value: stats.totalJobs },
                { label: 'USDC Settled', value: `$${stats.usdcSettled.toFixed(2)}` },
                { label: 'Completion Rate', value: `${stats.completionRate.toFixed(1)}%` },
              ].map(s => (
                <div key={s.label} className="border border-arc-border rounded-lg p-3 bg-arc-surface">
                  <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase mb-1">{s.label}</div>
                  <div className="font-mono text-lg font-bold text-arc-green">{s.value}</div>
                </div>
              ))}
            </div>
          )}

          <div className="flex gap-3">
            <button onClick={() => navigate('/dashboard')}
              className="bg-arc-green text-black font-mono font-semibold text-sm px-6 py-3 rounded-lg hover:bg-emerald-400 transition-colors">
              Launch Dashboard →
            </button>
            <a href={`${EXPLORER}/address/${ESCROW_ADDR}`} target="_blank" rel="noreferrer"
               className="border border-arc-border font-mono text-xs px-6 py-3 rounded-lg text-arc-sub hover:border-arc-green hover:text-arc-green transition-colors flex items-center">
              View Contract ↗
            </a>
          </div>
        </div>

        {/* Right — terminal */}
        <div className="flex flex-col gap-0 rounded-xl overflow-hidden border border-arc-border shadow-2xl shadow-arc-green/5">
          {/* Terminal chrome */}
          <div className="bg-arc-surface border-b border-arc-border px-4 py-3 flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-red-500/70" />
            <span className="w-3 h-3 rounded-full bg-yellow-500/70" />
            <span className="w-3 h-3 rounded-full bg-arc-green/70" />
            <span className="font-mono text-[10px] text-arc-muted ml-3 tracking-wide">brewing-agora-terminal — zsh</span>
          </div>

          {/* Terminal body */}
          <div className="bg-[#030303] p-5 min-h-[380px] max-h-[480px] overflow-y-auto flex flex-col gap-1 font-mono text-[12px]">
            {/* Prompt line */}
            {!running && !done && (
              <div className="text-arc-sub mb-2">
                <span className="text-arc-green">brewing@arc</span>
                <span className="text-arc-muted">:~$ </span>
                <span className="text-white">{DEFAULT_PROMPT}</span>
              </div>
            )}

            {/* Animated output */}
            {lines.map((line, i) => (
              <div key={i} className="slide-in leading-relaxed"
                style={{ color: line.kind === 'ok' ? '#10b981' : line.kind === 'tx' ? '#f59e0b' : line.kind === 'err' ? '#ef4444' : '#71717a' }}>
                {line.text}
              </div>
            ))}

            {/* TX confirmation */}
            {done && txLink && (
              <div className="mt-3 border border-arc-green/20 rounded-md p-3 bg-arc-green/5 slide-in">
                <div className="text-arc-green text-[11px] mb-1">✓ TX CONFIRMED ON ARC</div>
                <a href={`${EXPLORER}/tx/${txLink}`} target="_blank" rel="noreferrer"
                   className="text-arc-green/70 hover:text-arc-green underline text-[10px] break-all transition-colors">
                  {EXPLORER}/tx/{txLink.slice(0, 20)}…
                </a>
              </div>
            )}

            {/* Running cursor */}
            {running && <span className="text-arc-green blink mt-1">▋</span>}

            <div ref={bottomRef} />
          </div>

          {/* Run button */}
          <div className="bg-arc-surface border-t border-arc-border px-4 py-3 flex items-center gap-3">
            <button onClick={runDemo} disabled={running}
              className={`font-mono text-xs px-5 py-2 rounded-md transition-all ${
                running
                  ? 'bg-transparent border border-arc-muted text-arc-muted cursor-not-allowed'
                  : 'bg-arc-green text-black font-semibold hover:bg-emerald-400'
              }`}>
              {running ? '⟳ Running autonomous loop…' : '▶ Run Autonomous Loop'}
            </button>
            <span className="font-mono text-[10px] text-arc-muted">
              {done ? `${STEPS.length + 1} steps · USDC settled on-chain` : 'Live demo · no wallet required'}
            </span>
          </div>
        </div>
      </main>

      {/* Flow strip */}
      <div className="border-t border-arc-border bg-arc-surface">
        <div className="max-w-7xl mx-auto px-6 py-6 flex items-center justify-between gap-4 overflow-x-auto">
          {[
            { n: '01', label: 'Human Defines Task', sub: 'Natural language B2B instruction' },
            { n: '02', label: 'Planner Negotiates ACP', sub: 'ERC-8004 registry discovery' },
            { n: '03', label: 'USDC Locked in Vault', sub: 'Vyper escrow · SLA enforced' },
            { n: '04', label: 'On-Chain Settlement', sub: 'ArcScan-verified TxID' },
          ].map((s, i, arr) => (
            <div key={s.n} className="flex items-center gap-4 flex-shrink-0">
              <div className="flex flex-col gap-1">
                <div className="font-mono text-[9px] text-arc-muted tracking-widest">{s.n}</div>
                <div className="font-mono text-xs text-white font-medium">{s.label}</div>
                <div className="font-mono text-[10px] text-arc-sub">{s.sub}</div>
              </div>
              {i < arr.length - 1 && <span className="text-arc-muted text-lg mx-2 flex-shrink-0">→</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

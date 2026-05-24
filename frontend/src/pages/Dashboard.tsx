import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'

const API      = import.meta.env.VITE_ARC_API_URL ?? 'http://localhost:8000'
const EXPLORER = 'https://testnet.arcscan.app'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SubTask {
  agent_name:  string
  description: string
  status:      string   // locking | working | completed
  job_id:      number | null
  create_tx:   string | null
  settle_tx:   string | null
  result:      string | null
}

interface TaskRecord {
  task_id:          string
  employer_address: string
  employer_name:    string
  description:      string
  budget_usdc:      number
  deadline_hours:   number
  status:           string   // pending | in_progress | completed | refunded
  result:           string | null
  subtasks:         SubTask[]
  created_at:       number
  completed_at:     number | null
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function StatusBadge({ status }: { status: string }) {
  const cfg: Record<string, string> = {
    completed:   'bg-arc-green/10 text-arc-green border-arc-green/20',
    in_progress: 'bg-arc-amber/10 text-arc-amber border-arc-amber/20',
    refunded:    'bg-red-500/10 text-red-400 border-red-500/20',
    pending:     'border-arc-border text-arc-muted',
  }
  const label: Record<string, string> = {
    completed:   'Completed',
    in_progress: 'In Progress',
    refunded:    'Refunded',
    pending:     'Pending',
  }
  return (
    <span className={`font-mono text-[10px] px-2 py-0.5 rounded border ${cfg[status] ?? 'border-arc-border text-arc-muted'}`}>
      {label[status] ?? status}
    </span>
  )
}

function Countdown({ createdAt, deadlineHours }: { createdAt: number; deadlineHours: number }) {
  const [remaining, setRemaining] = useState(0)

  useEffect(() => {
    const deadline = createdAt + deadlineHours * 3600
    const update = () => setRemaining(Math.max(0, deadline - Math.floor(Date.now() / 1000)))
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [createdAt, deadlineHours])

  const h = Math.floor(remaining / 3600)
  const m = Math.floor((remaining % 3600) / 60)
  const s = remaining % 60
  const fmt = (n: number) => String(n).padStart(2, '0')

  return (
    <span className={`font-mono text-[11px] ${remaining < 3600 ? 'text-red-400' : 'text-arc-sub'}`}>
      {fmt(h)}:{fmt(m)}:{fmt(s)} remaining
    </span>
  )
}

// ── Tab 1: Post a Task ────────────────────────────────────────────────────────

function PostTaskTab({ onTaskPosted }: { onTaskPosted: () => void }) {
  const [desc, setDesc]         = useState('')
  const [budget, setBudget]     = useState('0.10')
  const [deadline, setDeadline] = useState('24')
  const [submitting, setSub]    = useState(false)
  const [result, setResult]     = useState<TaskRecord | null>(null)
  const [error, setError]       = useState('')

  const employerAddress = localStorage.getItem('brewing_employer_address') || ''
  const employerName    = localStorage.getItem('brewing_employer_name') || ''

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!desc.trim() || submitting) return
    setSub(true); setError(''); setResult(null)

    try {
      const res = await fetch(`${API}/api/tasks`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          description:      desc.trim(),
          budget_usdc:      parseFloat(budget) || 0.10,
          deadline_hours:   parseInt(deadline) || 24,
          employer_address: employerAddress,
          employer_name:    employerName,
        }),
        signal: AbortSignal.timeout(120_000),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.detail ?? 'Request failed')
      }
      const data: TaskRecord = await res.json()
      setResult(data)
      setDesc('')
      onTaskPosted()
    } catch (err: unknown) {
      setError((err as Error).message ?? 'Something went wrong')
    } finally {
      setSub(false)
    }
  }

  return (
    <div className="flex flex-col gap-6 max-w-2xl">
      <div>
        <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase mb-1">POST A TASK</div>
        <p className="font-mono text-[12px] text-arc-sub">Describe what you need. Brewing selects the best agent, locks USDC in escrow, and releases payment when done.</p>
      </div>

      <form onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Task Description</label>
          <textarea
            value={desc}
            onChange={e => setDesc(e.target.value)}
            placeholder="e.g. Research the top 5 competitors in the DeFi lending space and summarise their key differentiators..."
            rows={5}
            required
            className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white placeholder-arc-muted focus:outline-none focus:border-arc-green transition-colors resize-none"
          />
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Budget (USDC)</label>
            <input
              type="number"
              min="0.01"
              step="0.01"
              value={budget}
              onChange={e => setBudget(e.target.value)}
              className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white focus:outline-none focus:border-arc-green transition-colors"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="font-mono text-[10px] text-arc-muted tracking-widest uppercase">Deadline</label>
            <select
              value={deadline}
              onChange={e => setDeadline(e.target.value)}
              className="bg-arc-surface border border-arc-border rounded-lg px-4 py-3 font-mono text-sm text-white focus:outline-none focus:border-arc-green transition-colors"
            >
              <option value="1">1 hour</option>
              <option value="6">6 hours</option>
              <option value="24">24 hours</option>
              <option value="72">3 days</option>
            </select>
          </div>
        </div>

        {error && (
          <div className="border border-red-500/20 rounded-lg px-4 py-3 bg-red-500/5">
            <span className="font-mono text-xs text-red-400">{error}</span>
          </div>
        )}

        <button
          type="submit"
          disabled={submitting || !desc.trim()}
          className={`font-mono font-semibold text-sm px-6 py-3 rounded-lg transition-all ${
            submitting || !desc.trim()
              ? 'bg-arc-surface border border-arc-border text-arc-muted cursor-not-allowed'
              : 'bg-arc-green text-black hover:bg-emerald-400'
          }`}
        >
          {submitting ? '⟳ Agent working… this takes ~30s' : '▶ Submit Task'}
        </button>
        {submitting && (
          <p className="font-mono text-[10px] text-arc-muted">Selecting agent → locking escrow → running task → settling USDC…</p>
        )}
      </form>

      {/* Confirmation */}
      {result && result.status === 'completed' && (
        <div className="flex flex-col gap-4">
          <div className="border border-arc-green/20 rounded-xl bg-arc-green/5 p-5 flex flex-col gap-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-arc-green text-sm">✓</span>
                <span className="font-mono text-xs font-semibold text-arc-green">3-agent pipeline complete · {result.budget_usdc.toFixed(3)} USDC settled</span>
              </div>
              <StatusBadge status={result.status} />
            </div>
            <div className="font-mono text-[11px] text-white leading-relaxed bg-black/40 rounded-lg p-4 border border-arc-border">
              {result.result}
            </div>
          </div>
          {result.subtasks.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase">AGENT BREAKDOWN</div>
              {result.subtasks.map(st => (
                <div key={st.agent_name} className="border border-arc-border rounded-lg bg-arc-surface p-4 flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[11px] font-semibold text-white">{st.agent_name}</span>
                    <div className="flex items-center gap-3 font-mono text-[10px] text-arc-muted">
                      {st.create_tx && <a href={`${EXPLORER}/tx/${st.create_tx}`} target="_blank" rel="noreferrer" className="text-arc-green hover:underline">Escrow ↗</a>}
                      {st.settle_tx && <a href={`${EXPLORER}/tx/${st.settle_tx}`} target="_blank" rel="noreferrer" className="text-arc-green hover:underline">Settlement ↗</a>}
                    </div>
                  </div>
                  <p className="font-mono text-[10px] text-arc-sub leading-relaxed">{st.result}</p>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ── Tab 2: Active Jobs ────────────────────────────────────────────────────────

function ActiveJobsTab() {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [loading, setLoad] = useState(true)

  const refresh = useCallback(async () => {
    try {
      const data = await fetch(`${API}/api/tasks`).then(r => r.json())
      setTasks(data as TaskRecord[])
    } catch { /* offline */ } finally { setLoad(false) }
  }, [])

  useEffect(() => {
    refresh()
    const id = setInterval(refresh, 5000)
    return () => clearInterval(id)
  }, [refresh])

  if (loading) return <div className="font-mono text-xs text-arc-muted mt-8">Loading jobs…</div>

  if (tasks.length === 0) return (
    <div className="border border-arc-border rounded-xl p-12 text-center">
      <div className="font-mono text-xs text-arc-muted">No tasks yet — post your first task</div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase">{tasks.length} TASK{tasks.length !== 1 ? 'S' : ''} TOTAL</div>
      {tasks.map(task => (
        <div key={task.task_id} className="border border-arc-border rounded-xl bg-arc-surface overflow-hidden hover:border-arc-green/30 transition-colors">
          {/* Header */}
          <div className="border-b border-arc-border px-5 py-3 flex items-center justify-between gap-3">
            <div className="flex items-center gap-3 min-w-0">
              <span className="font-mono text-[10px] text-arc-muted flex-shrink-0">#{task.task_id}</span>
              {task.agent_name && (
                <span className="font-mono text-[10px] text-arc-sub">→ {task.agent_name}</span>
              )}
            </div>
            <div className="flex items-center gap-3 flex-shrink-0">
              <span className="font-mono text-[11px] text-arc-amber font-bold">{task.budget_usdc.toFixed(3)} USDC</span>
              <StatusBadge status={task.status} />
            </div>
          </div>

          {/* Body */}
          <div className="px-5 py-4 flex flex-col gap-3">
            <p className="font-mono text-[12px] text-white leading-relaxed">{task.description}</p>

            <div className="flex flex-wrap gap-4 font-mono text-[10px] text-arc-muted">
              {task.status === 'in_progress' && (
                <Countdown createdAt={task.created_at} deadlineHours={task.deadline_hours} />
              )}
              {task.completed_at && (
                <span>Completed {new Date(task.completed_at * 1000).toLocaleTimeString()}</span>
              )}
              {task.create_tx && (
                <a href={`${EXPLORER}/tx/${task.create_tx}`} target="_blank" rel="noreferrer" className="text-arc-green hover:underline">
                  Escrow ↗
                </a>
              )}
              {task.settle_tx && (
                <a href={`${EXPLORER}/tx/${task.settle_tx}`} target="_blank" rel="noreferrer" className="text-arc-green hover:underline">
                  Settlement ↗
                </a>
              )}
            </div>

            {/* Sub-tasks */}
            {task.subtasks.length > 0 && (
              <div className="flex flex-col gap-2 mt-1">
                <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase">AGENT PIPELINE</div>
                {task.subtasks.map(st => (
                  <div key={st.agent_name} className="border border-arc-border rounded-lg bg-black/40 p-3 flex flex-col gap-1.5">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`font-mono text-[10px] ${st.status === 'completed' ? 'text-arc-green' : st.status === 'working' ? 'text-arc-amber' : 'text-arc-muted'}`}>
                          {st.status === 'completed' ? '✓' : st.status === 'working' ? '⟳' : '○'}
                        </span>
                        <span className="font-mono text-[11px] font-semibold text-white">{st.agent_name}</span>
                      </div>
                      <div className="flex gap-3 font-mono text-[10px]">
                        {st.create_tx && <a href={`${EXPLORER}/tx/${st.create_tx}`} target="_blank" rel="noreferrer" className="text-arc-green hover:underline">Escrow ↗</a>}
                        {st.settle_tx && <a href={`${EXPLORER}/tx/${st.settle_tx}`} target="_blank" rel="noreferrer" className="text-arc-green hover:underline">Settlement ↗</a>}
                      </div>
                    </div>
                    {st.result && <p className="font-mono text-[10px] text-arc-sub leading-relaxed">{st.result}</p>}
                  </div>
                ))}
              </div>
            )}
            {/* Final combined result */}
            {task.result && (
              <div className="border border-arc-green/20 rounded-lg p-4 bg-arc-green/5 mt-1">
                <div className="font-mono text-[9px] text-arc-green tracking-widest uppercase mb-2">COMBINED RESULT</div>
                <p className="font-mono text-[11px] text-white leading-relaxed">{task.result}</p>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Tab 3: Receipts ────────────────────────────────────────────────────────────

function ReceiptsTab() {
  const [tasks, setTasks] = useState<TaskRecord[]>([])
  const [loading, setLoad] = useState(true)

  useEffect(() => {
    fetch(`${API}/api/tasks`)
      .then(r => r.json())
      .then((d: TaskRecord[]) => setTasks(d.filter(t => t.status === 'completed')))
      .catch(() => null)
      .finally(() => setLoad(false))
  }, [])

  const download = (task: TaskRecord) => {
    const content = [
      `BREWING TASK RECEIPT`,
      `═══════════════════════════════`,
      `Task ID:      ${task.task_id}`,
      `Receipt ID:   ${task.receipt_id ?? '—'}`,
      `Agents:       ${task.subtasks.length > 0 ? task.subtasks.map(s => s.agent_name).join(', ') : '—'}`,
      `Description:  ${task.description}`,
      `USDC Paid:    ${task.budget_usdc.toFixed(3)}`,
      `Completed:    ${task.completed_at ? new Date(task.completed_at * 1000).toISOString() : '—'}`,
      ...task.subtasks.map(st =>
        `${st.agent_name}: escrow=${st.create_tx ? `${EXPLORER}/tx/${st.create_tx}` : '—'} settle=${st.settle_tx ? `${EXPLORER}/tx/${st.settle_tx}` : '—'}`
      ),
      ``,
      `RESULT`,
      `───────`,
      task.result ?? '—',
    ].join('\n')

    const blob = new Blob([content], { type: 'text/plain' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    a.href = url; a.download = `brewing-receipt-${task.task_id}.txt`; a.click()
    URL.revokeObjectURL(url)
  }

  if (loading) return <div className="font-mono text-xs text-arc-muted mt-8">Loading receipts…</div>

  if (tasks.length === 0) return (
    <div className="border border-arc-border rounded-xl p-12 text-center">
      <div className="font-mono text-xs text-arc-muted">No completed tasks yet</div>
    </div>
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="font-mono text-[9px] text-arc-muted tracking-widest uppercase">{tasks.length} COMPLETED TASK{tasks.length !== 1 ? 'S' : ''}</div>
      {tasks.map(task => (
        <div key={task.task_id} className="border border-arc-border rounded-xl bg-arc-surface overflow-hidden">
          <div className="border-b border-arc-border px-5 py-3 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <span className="text-arc-green text-xs">✓</span>
              <span className="font-mono text-[11px] text-white">
                {task.subtasks.length > 0 ? task.subtasks.map(s => s.agent_name).join(' · ') : 'Agent'}
              </span>
              <span className="font-mono text-[10px] text-arc-muted">#{task.task_id}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-[11px] text-arc-amber font-bold">{task.budget_usdc.toFixed(3)} USDC</span>
              <button
                onClick={() => download(task)}
                className="font-mono text-[10px] text-arc-sub border border-arc-border rounded px-2 py-1 hover:border-arc-green hover:text-arc-green transition-colors"
              >
                ↓ Download
              </button>
            </div>
          </div>
          <div className="px-5 py-4 flex flex-col gap-3">
            <p className="font-mono text-[11px] text-arc-sub">{task.description}</p>
            <div className="flex flex-wrap gap-4 font-mono text-[10px] text-arc-muted">
              {task.completed_at && <span>{new Date(task.completed_at * 1000).toLocaleString()}</span>}
              <span>{task.subtasks.filter(s => s.status === 'completed').length}/{task.subtasks.length} agents settled</span>
              {task.subtasks.find(s => s.settle_tx) && (
                <a href={`${EXPLORER}/tx/${task.subtasks.find(s => s.settle_tx)!.settle_tx!}`} target="_blank" rel="noreferrer" className="text-arc-green hover:underline">
                  On-chain proof ↗
                </a>
              )}
            </div>
            {task.result && (
              <div className="border border-arc-border rounded-lg p-4 bg-black/40">
                <p className="font-mono text-[11px] text-white leading-relaxed">{task.result}</p>
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ── Dashboard shell ───────────────────────────────────────────────────────────

export default function Dashboard() {
  const navigate = useNavigate()
  const [tab, setTab]         = useState<'post' | 'jobs' | 'receipts'>('post')
  const [refreshKey, setRefreshKey] = useState(0)

  const employerName = localStorage.getItem('brewing_employer_name') || ''

  const TABS = [
    { id: 'post'     as const, label: 'Post a Task',  sub: 'New task · escrow · settle' },
    { id: 'jobs'     as const, label: 'Active Jobs',  sub: 'Status · results · timers'  },
    { id: 'receipts' as const, label: 'Receipts',     sub: 'History · proof · download' },
  ]

  return (
    <div className="min-h-screen bg-black text-white flex flex-col">

      {/* Nav */}
      <nav className="border-b border-arc-border sticky top-0 z-50 bg-black/90 backdrop-blur-md">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <button onClick={() => navigate('/')} className="font-mono font-bold text-sm tracking-[0.2em] hover:text-arc-green transition-colors">
              BREWING
            </button>
            <span className="text-arc-border">/</span>
            <span className="font-mono text-xs text-arc-sub">
              {employerName ? `${employerName} Dashboard` : 'Dashboard'}
            </span>
          </div>
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-arc-green pulse-dot" />
              <span className="font-mono text-[11px] text-arc-green tracking-wide">Arc Testnet Live</span>
            </div>
            <button
              onClick={() => navigate('/onboard')}
              className="font-mono text-[10px] text-arc-sub border border-arc-border rounded px-3 py-1.5 hover:border-arc-green hover:text-arc-green transition-colors"
            >
              + New Account
            </button>
          </div>
        </div>
      </nav>

      {/* Tab bar */}
      <div className="border-b border-arc-border bg-arc-surface">
        <div className="max-w-6xl mx-auto px-6 flex">
          {TABS.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)}
              className={`px-6 py-4 flex flex-col gap-0.5 border-b-2 transition-all ${
                tab === t.id ? 'border-arc-green text-white' : 'border-transparent text-arc-muted hover:text-arc-sub'
              }`}
            >
              <span className="font-mono text-xs font-semibold tracking-wide">{t.label}</span>
              <span className="font-mono text-[9px] text-arc-muted">{t.sub}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Content */}
      <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">
        {tab === 'post'     && <PostTaskTab onTaskPosted={() => { setRefreshKey(k => k + 1); setTab('jobs') }} />}
        {tab === 'jobs'     && <ActiveJobsTab key={refreshKey} />}
        {tab === 'receipts' && <ReceiptsTab />}
      </main>
    </div>
  )
}

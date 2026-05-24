"""
Brewing Arc Agent Loop — Full Four-Pillar Demo
==============================================
Demonstrates the complete agentic economy on Arc L1:

  Pillar A (ACP):        Employer queries registry, picks worker by reputation
  Pillar B (AgentVaults): USDC locks in escrow, SLA enforced on-chain
  Pillar C (Identity):   Signed work receipt produced on every settlement
  Pillar D (DCW):        Agent wallets provisioned via Circle MPC

Run:
    cd ~/arc
    python3 -m backend.agent           # full demo (3 jobs)
    python3 -m backend.agent slash     # adversarial SLA breach demo
"""
import asyncio
import hashlib
import os
import sys
import time
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

import anthropic

from backend.brewing_sdk    import BrewingArcClient, paced_api_call
from backend.registry       import registry, AgentCard
from backend.circle_wallets import provision_agent_wallet
from backend.receipts       import sign_receipt, receipt_store


def prompt_to_ipfs_hash(prompt: str) -> bytes:
    """
    Deterministic bytes32 from a job prompt.
    sha256(prompt) → 32 bytes stored on-chain as ipfs_spec_hash.
    Anyone with the prompt can verify it matches the on-chain hash.
    """
    return hashlib.sha256(prompt.encode()).digest()

# ── Config ────────────────────────────────────────────────────────────────────

EXPLORER    = "https://testnet.arcscan.app"
JOB_AMOUNT  = 0.10
SLA_TIMEOUT = 300

DEMO_JOBS = [
    {
        "capability": "research",
        "prompt": (
            "You are a specialist research agent. "
            "Summarise in 3 bullet points why Arc L1 (Circle's stablecoin-native EVM chain) "
            "is a better settlement layer for AI agent economies than general-purpose EVM chains. "
            "Keep each bullet under 25 words."
        ),
    },
    {
        "capability": "analysis",
        "prompt": (
            "You are a DeFi analyst agent. "
            "List 3 concrete risks of using volatile gas tokens (ETH, MATIC) for autonomous "
            "agent-to-agent micropayments. Keep each risk under 20 words."
        ),
    },
    {
        "capability": "strategy",
        "prompt": (
            "You are a product strategy agent. "
            "In exactly 2 sentences, explain how Brewing's escrow + SLA slash mechanism "
            "creates trust between AI agents that have never interacted before."
        ),
    },
]

# ── Logging ───────────────────────────────────────────────────────────────────

def log(msg: str):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)

def tx_link(tx: str) -> str:
    return f"{EXPLORER}/tx/0x{tx.lstrip('0x')}"

# ── Worker: Claude executes the task ─────────────────────────────────────────

async def run_worker_task(prompt: str) -> str:
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        return "[DEMO MODE] No ANTHROPIC_API_KEY set."

    client = anthropic.Anthropic(api_key=api_key)

    async def _call():
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(
            None,
            lambda: client.messages.create(
                model="claude-opus-4-5",
                max_tokens=300,
                messages=[{"role": "user", "content": prompt}],
            )
        )

    response = await paced_api_call(_call())
    return response.content[0].text.strip()

# ── Seed the registry with demo worker agents ─────────────────────────────────

def seed_registry(arc: BrewingArcClient) -> dict[str, AgentCard]:
    """
    Register three specialist worker agents in the Brewing directory.
    Each agent gets a Circle-managed MPC wallet (or ephemeral fallback).
    """
    log("Seeding agent registry (Pillar A: ACP Discovery)…")
    agents = {}

    specs = [
        ("ResearchBot",  ["research", "market-analysis", "literature-review"]),
        ("AnalystBot",   ["analysis", "defi", "risk-assessment", "competitive-analysis"]),
        ("StrategyBot",  ["strategy", "product", "positioning", "roadmap"]),
    ]

    for name, caps in specs:
        wallet = provision_agent_wallet(name)
        card   = registry.register(
            name         = name,
            owner        = arc.account.address,   # human principal
            payment_addr = wallet.address,
            capabilities = caps,
            endpoint     = f"http://localhost:8000/agents/{name.lower()}",
        )
        agents[name] = card
        log(f"  ✓ {name} registered  wallet={wallet.address[:10]}… [{wallet.provider}]")

    return agents

# ── Main demo loop ────────────────────────────────────────────────────────────

async def run_demo():
    log("Brewing Arc Agent — starting up")
    arc = BrewingArcClient()

    log(f"Employer: {arc.account.address}")
    log(f"Escrow:   {arc.escrow.address}")
    log(f"Explorer: {EXPLORER}/address/{arc.escrow.address}")
    log("─" * 60)

    # Pillar A + D: seed registry with Circle-provisioned agent wallets
    seed_registry(arc)
    log(f"\n{len(registry.all())} agents registered in Brewing directory")
    log("─" * 60)

    employer_key = os.getenv("ARC_PRIVATE_KEY", "")
    results = []

    for i, job_spec in enumerate(DEMO_JOBS, 1):
        cap = job_spec["capability"]
        log(f"\nJob {i}/{len(DEMO_JOBS)} — capability: {cap}")

        # ── Pillar A: ACP — discover best worker by reputation ────────────────
        candidates = registry.find(cap)
        if not candidates:
            log(f"  ✗ No agents found for capability '{cap}'")
            continue

        worker_card = candidates[0]
        log(f"  ACP: selected {worker_card.name} "
            f"(reputation={worker_card.reputation:.0f} bps, "
            f"{worker_card.jobs_completed} completed)")

        # ── Pillar B: AgentVaults — lock USDC in escrow ───────────────────────
        ipfs_hash = prompt_to_ipfs_hash(job_spec["prompt"])
        log(f"  Posting job to escrow ({JOB_AMOUNT} USDC, {SLA_TIMEOUT}s SLA)…")
        log(f"  spec_hash: {ipfs_hash.hex()[:16]}…  (sha256 of prompt, stored on-chain)")
        try:
            result    = await arc.post_job(
                worker          = worker_card.payment_addr,
                usdc_amount     = JOB_AMOUNT,
                timeout_seconds = SLA_TIMEOUT,
                ipfs_hash       = ipfs_hash,
            )
            job_id    = result["job_id"]
            create_tx = result["create_tx"]
            log(f"  ✓ Job #{job_id} — USDC locked in escrow")
            log(f"    {tx_link(create_tx)}")
        except Exception as e:
            log(f"  ✗ create_job failed: {e}")
            continue

        # ── Pillar A: worker executes via Claude ──────────────────────────────
        log(f"  Worker agent ({worker_card.name}) running task…")
        output = await run_worker_task(job_spec["prompt"])
        log(f"  ✓ Task output:")
        for line in output.split("\n"):
            if line.strip():
                log(f"      {line}")

        # ── Pillar B: settle escrow ───────────────────────────────────────────
        log(f"  Settling escrow (releasing USDC to {worker_card.name})…")
        try:
            settle_tx = await arc.complete_job(job_id)
            log(f"  ✓ Job #{job_id} settled — "
                f"{JOB_AMOUNT} USDC → {worker_card.payment_addr[:10]}…")
            log(f"    {tx_link(settle_tx)}")
        except Exception as e:
            log(f"  ✗ complete_job failed: {e}")
            continue

        # ── Pillar C: produce signed work receipt ─────────────────────────────
        if employer_key:
            receipt = sign_receipt(
                job_id          = job_id,
                employer_addr   = arc.account.address,
                employer_key    = employer_key,
                worker_addr     = worker_card.payment_addr,
                worker_agent_id = worker_card.agent_id,
                task_type       = cap,
                output_text     = output,
                amount_usdc     = JOB_AMOUNT,
                tx_hash         = settle_tx,
            )
            receipt_store.save(receipt)
            log(f"  ✓ Receipt #{receipt.receipt_id[:12]}… signed by employer")
            log(f"    verify: output_hash={receipt.output_hash[:16]}…")

        # ── Pillar A: update agent reputation ─────────────────────────────────
        registry.record_completion(worker_card.agent_id)
        log(f"  ✓ {worker_card.name} reputation → {worker_card.reputation:.0f} bps")

        results.append({
            "job_id":    job_id,
            "worker":    worker_card.name,
            "cap":       cap,
            "create_tx": create_tx,
            "settle_tx": settle_tx,
        })
        log(f"  ─ Job {i} done ─")
        await asyncio.sleep(2.0)

    # ── Summary ───────────────────────────────────────────────────────────────
    log("\n" + "═" * 60)
    log("BREWING DEMO COMPLETE")
    log("═" * 60)

    jobs      = await arc.get_all_jobs()
    completed = [j for j in jobs if j.status == "Completed"]
    log(f"Jobs settled:   {len(completed)}")
    log(f"USDC settled:   ${sum(j.amount_usdc for j in completed):.2f}")
    log(f"Receipts issued:{len(receipt_store.all())}")
    log(f"\nAgent reputations after settlement:")
    for card in registry.all():
        log(f"  {card.name:14s}  {card.reputation:6.0f} bps  "
            f"({card.jobs_completed}✓ / {card.jobs_slashed}✗)")
    log(f"\nAll TXs on Arc testnet:")
    for r in results:
        log(f"  Job #{r['job_id']} ({r['worker']}): {tx_link(r['create_tx'])}")

# ── Slash demo ────────────────────────────────────────────────────────────────

async def run_slash_demo():
    log("\nAdversarial demo: SLA breach → slash → employer refunded")
    arc  = BrewingArcClient()

    seed_registry(arc)

    # Pick any agent — they're going to miss the 1-second SLA
    candidates = registry.find("research")
    worker     = candidates[0]
    log(f"  Worker: {worker.name} ({worker.payment_addr[:10]}…)")

    log("  Posting job with 1-second SLA…")
    result = await arc.post_job(
        worker          = worker.payment_addr,
        usdc_amount     = 0.05,
        timeout_seconds = 1,
    )
    job_id = result["job_id"]
    log(f"  ✓ Job #{job_id} created  {tx_link(result['create_tx'])}")

    log("  Waiting 3s for SLA to expire…")
    await asyncio.sleep(3)

    log("  Slashing (SLA breached)…")
    slash_tx = await arc.slash_job(job_id)
    log(f"  ✓ Job #{job_id} slashed — USDC refunded to employer")
    log(f"    {tx_link(slash_tx)}")

    # Slash updates reputation
    registry.record_slash(worker.agent_id)
    log(f"  ✓ {worker.name} reputation → {worker.reputation:.0f} bps (slashed)")

# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "demo"
    asyncio.run(run_slash_demo() if mode == "slash" else run_demo())

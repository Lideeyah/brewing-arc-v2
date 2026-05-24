"""
Brewing Arc API — FastAPI backend
Exposes all four pillars over HTTP for the React dashboard.

Run locally:
    cd ~/arc
    uvicorn backend.main:app --reload --port 8000
"""
import asyncio
import os
import time
from contextlib import asynccontextmanager
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.brewing_sdk    import BrewingArcClient, paced_api_call
from backend.registry       import registry, compute_reputation
from backend.circle_wallets import provision_agent_wallet
from backend.receipts       import sign_receipt, receipt_store

# ── App lifecycle ─────────────────────────────────────────────────────────────

client: BrewingArcClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    client = BrewingArcClient()
    # Seed registry with demo agents on startup
    _seed_registry()
    yield


def _seed_registry():
    """Seed registry with demo agents — skip any already registered (preserves reputation)."""
    import hashlib
    specs = [
        ("ResearchBot",  ["research", "market-analysis", "literature-review"]),
        ("AnalystBot",   ["analysis", "defi", "risk-assessment", "competitive-analysis"]),
        ("StrategyBot",  ["strategy", "product", "positioning", "roadmap"]),
    ]
    owner = client.account.address
    for name, caps in specs:
        # Deterministic ID — same formula as registry._make_id
        agent_id = hashlib.sha256(f"{owner.lower()}:{name.lower()}".encode()).hexdigest()[:16]
        if registry.get(agent_id):
            continue  # already registered — keep existing reputation
        wallet = provision_agent_wallet(name)
        registry.register(
            name         = name,
            owner        = owner,
            payment_addr = wallet.address,
            capabilities = caps,
            endpoint     = f"http://localhost:8000/agents/{name.lower()}",
        )


app = FastAPI(title="Brewing Arc API", version="2.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request models ────────────────────────────────────────────────────────────

class PostJobRequest(BaseModel):
    worker:          str
    usdc_amount:     float
    timeout_seconds: int = 3600

# ── Wallet ───────────────────────────────────────────────────────────────────

@app.get("/api/wallet")
async def get_wallet():
    addr = os.getenv("CIRCLE_WALLET_ADDRESS", "")
    balance_usdc = 0.0
    if client and addr:
        try:
            bal_wei = client.w3.eth.get_balance(client.w3.to_checksum_address(addr))
            balance_usdc = round(bal_wei / 10**18, 4)
        except Exception:
            pass
    return {"address": addr, "balance_usdc": balance_usdc, "network": "arc-testnet", "type": "SCA"}

# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    return {
        "status":   "ok",
        "network":  "arc-testnet",
        "agents":   len(registry.all()),
        "receipts": len(receipt_store.all()),
        "circle_dcw": provision_agent_wallet.__module__,
    }

# ── Pillar A: Agent Registry / ACP Discovery ──────────────────────────────────

@app.get("/api/agents")
async def get_agents():
    """List all registered agents, ranked by reputation."""
    return registry.to_dict()


@app.get("/api/agents/find/{capability}")
async def find_agents(capability: str):
    """
    ACP Discovery — return agents capable of handling this task,
    ranked by on-chain reputation score.
    """
    candidates = registry.find(capability)
    if not candidates:
        raise HTTPException(status_code=404, detail=f"No agents found for '{capability}'")
    return [c.__dict__ for c in candidates]


@app.get("/api/agents/{agent_id}")
async def get_agent(agent_id: str):
    card = registry.get(agent_id)
    if not card:
        raise HTTPException(status_code=404, detail="Agent not found")
    return card.__dict__

# ── Pillar B: Escrow / AgentVaults ────────────────────────────────────────────

@app.post("/api/jobs")
async def post_job(req: PostJobRequest):
    try:
        result = await client.post_job(req.worker, req.usdc_amount, req.timeout_seconds)
        return result
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/jobs/{job_id}/complete")
async def complete_job(job_id: int):
    try:
        tx = await client.complete_job(job_id)
        return {"tx_hash": tx, "job_id": job_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.post("/api/jobs/{job_id}/slash")
async def slash_job(job_id: int):
    try:
        tx = await client.slash_job(job_id)
        return {"tx_hash": tx, "job_id": job_id}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: int):
    try:
        return (await client.get_job(job_id)).__dict__
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@app.get("/api/jobs")
async def get_all_jobs():
    try:
        return [j.__dict__ for j in await client.get_all_jobs()]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/api/analytics")
async def analytics():
    try:
        jobs      = await client.get_all_jobs()
        completed = [j for j in jobs if j.status == "Completed"]
        slashed   = [j for j in jobs if j.status == "Slashed"]
        agents    = registry.all()

        return {
            "program": os.getenv("ESCROW_CONTRACT_ADDRESS", "not-deployed"),
            "network": "arc-testnet",
            "metrics": {
                "totalJobs":      len(jobs),
                "completedJobs":  len(completed),
                "slashedJobs":    len(slashed),
                "completionRate": round(len(completed) / len(jobs) * 100, 1) if jobs else 0,
                "usdcSettled":    round(sum(j.amount_usdc for j in completed), 6),
                "usdcSlashed":    round(sum(j.amount_usdc for j in slashed), 6),
                "registeredAgents": len(agents),
                "receiptsIssued": len(receipt_store.all()),
            },
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Pillar C: Signed Receipts ─────────────────────────────────────────────────

@app.get("/api/receipts")
async def get_receipts():
    return [r.to_dict() for r in receipt_store.all()]


@app.get("/api/receipts/{receipt_id}")
async def get_receipt(receipt_id: str):
    r = receipt_store.get(receipt_id)
    if not r:
        raise HTTPException(status_code=404, detail="Receipt not found")
    return r.to_dict()


@app.get("/api/receipts/{receipt_id}/verify")
async def verify_receipt(receipt_id: str):
    r = receipt_store.get(receipt_id)
    if not r:
        raise HTTPException(status_code=404, detail="Receipt not found")
    valid = r.verify()
    return {"receipt_id": receipt_id, "valid": valid, "signer": r.employer}

# ── Demo trigger (dashboard button) ──────────────────────────────────────────

@app.post("/api/demo/run")
async def run_demo():
    """
    Full four-pillar demo triggered from the React dashboard.
    ACP discovery → escrow → Claude → settlement → signed receipt.
    """
    import anthropic as _anthropic

    log_lines: list[str] = []

    def emit(msg: str):
        log_lines.append(f"[{time.strftime('%H:%M:%S')}] {msg}")

    try:
        ai = _anthropic.Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))
        employer_key = os.getenv("ARC_PRIVATE_KEY", "")

        JOBS = [
            {
                "capability": "research",
                "prompt": (
                    "Summarise in 3 bullets why Arc L1 is a better settlement layer "
                    "for AI agent economies than general-purpose EVM chains. "
                    "Each bullet under 25 words."
                ),
            },
            {
                "capability": "strategy",
                "prompt": (
                    "In 2 sentences, explain how Brewing's escrow + SLA slash "
                    "creates trust between AI agents that have never interacted before."
                ),
            },
        ]

        for job_spec in JOBS:
            cap = job_spec["capability"]
            emit(f"ACP: discovering agents for '{cap}'…")
            candidates = registry.find(cap)
            if not candidates:
                emit(f"No agents found for '{cap}'")
                continue

            worker = candidates[0]
            emit(f"Selected {worker.name} (reputation={worker.reputation:.0f} bps)")

            emit(f"Locking 0.10 USDC in escrow…")
            result = await client.post_job(
                worker=worker.payment_addr, usdc_amount=0.10, timeout_seconds=300
            )
            job_id = result["job_id"]
            emit(f"Job #{job_id} funded ✓")

            emit(f"Claude running {cap} task…")
            loop   = asyncio.get_running_loop()
            resp   = await loop.run_in_executor(
                None,
                lambda p=job_spec["prompt"]: ai.messages.create(
                    model="claude-opus-4-5", max_tokens=250,
                    messages=[{"role": "user", "content": p}],
                )
            )
            output = resp.content[0].text.strip()
            for line in output.split("\n")[:2]:
                if line.strip():
                    emit(f"  → {line.strip()[:85]}")

            emit(f"Releasing USDC to {worker.name}…")
            settle_tx = await client.complete_job(job_id)
            emit(f"Job #{job_id} settled ✓ — 0.10 USDC on-chain")

            if employer_key:
                receipt = sign_receipt(
                    job_id=job_id,
                    employer_addr=client.account.address,
                    employer_key=employer_key,
                    worker_addr=worker.payment_addr,
                    worker_agent_id=worker.agent_id,
                    task_type=cap,
                    output_text=output,
                    amount_usdc=0.10,
                    tx_hash=settle_tx,
                )
                receipt_store.save(receipt)
                emit(f"Receipt #{receipt.receipt_id[:12]}… signed ✓")

            registry.record_completion(worker.agent_id)
            emit(f"{worker.name} reputation → {worker.reputation:.0f} bps ↑")
            await asyncio.sleep(1)

        emit("── BREWING DEMO COMPLETE ──")
    except Exception as e:
        emit(f"Error: {e}")

    return {"log": log_lines}

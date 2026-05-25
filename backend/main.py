"""
Brewing Arc API — FastAPI backend
B2B AI task marketplace on Circle Arc L1.

Run locally:
    cd ~/arc
    uvicorn backend.main:app --reload --port 8000
"""
import asyncio
import os
import time
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path

from dotenv import load_dotenv
load_dotenv(Path(__file__).parent.parent / ".env", override=True)

import json as _json_module
from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from backend.brewing_sdk    import BrewingArcClient
from backend.registry       import registry, compute_reputation
from backend.circle_wallets import provision_agent_wallet
from backend.receipts       import sign_receipt, receipt_store
from backend.tasks          import task_store, TaskRecord
from backend.businesses     import business_store

# ── Streaming event bus ───────────────────────────────────────────────────────
# Maps task_id → list of subscriber queues (one per SSE connection)
_task_streams: dict[str, list[asyncio.Queue]] = {}

async def _emit(task_id: str, event_type: str, **kwargs):
    """Broadcast a progress event to all SSE subscribers for a task."""
    payload = {"type": event_type, **kwargs}
    for q in _task_streams.get(task_id, []):
        await q.put(payload)

# ── App lifecycle ─────────────────────────────────────────────────────────────

client: BrewingArcClient | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global client
    client = BrewingArcClient()
    _seed_registry()
    yield


def _seed_registry():
    import hashlib
    specs = [
        ("MarketResearchBot", ["market-intelligence", "trading-signals", "research", "sector-analysis", "price-trends"]),
        ("SentimentBot",      ["sentiment-analysis", "news-analysis", "social-signals", "nlp", "market-mood"]),
        ("ArbitrageBot",      ["arbitrage", "price-discrepancy", "cross-market", "spread-detection", "execution-signals"]),
        ("PortfolioBot",      ["portfolio-analysis", "rebalancing", "asset-allocation", "risk-management", "recommendations"]),
        ("PredictionBot",     ["event-research", "probability-scoring", "forecasting", "scenario-analysis", "risk-prediction"]),
    ]
    owner = client.account.address
    for name, caps in specs:
        agent_id = hashlib.sha256(f"{owner.lower()}:{name.lower()}".encode()).hexdigest()[:16]
        if registry.get(agent_id):
            continue
        wallet = provision_agent_wallet(name)
        base_url = os.getenv("RENDER_EXTERNAL_URL", "http://localhost:8000")
        registry.register(
            name         = name,
            owner        = owner,
            payment_addr = wallet.address,
            capabilities = caps,
            endpoint     = f"{base_url}/agents/{name.lower()}",
        )


app = FastAPI(title="Brewing Arc API", version="3.0.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ── Request models ────────────────────────────────────────────────────────────

class OnboardRequest(BaseModel):
    name:  str
    email: str

class PostTaskRequest(BaseModel):
    description:      str
    budget_usdc:      float
    deadline_hours:   int   = 24
    employer_address: str   = ""
    employer_name:    str   = ""
    selected_agent:   str   = ""   # agent name chosen in marketplace; empty = pipeline
    drive_files:      list  = []   # [{name: str, content: str}]
    gmail_threads:    list  = []   # [{subject: str, content: str}]
    slack_messages:   list  = []   # [{channel: str, content: str}]

class PostJobRequest(BaseModel):
    worker:          str
    usdc_amount:     float
    timeout_seconds: int = 3600

class RegisterAgentRequest(BaseModel):
    name:           str
    description:    str
    capabilities:   list[str]
    payment_addr:   str
    price_per_task: float = 0.033
    webhook_url:    str

# ── Health ────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    from backend.store import USE_REDIS, _set, _get
    redis_ok = None
    if USE_REDIS:
        try:
            _set("brewing:healthcheck", "1")
            redis_ok = _get("brewing:healthcheck") == "1"
        except Exception as e:
            redis_ok = f"error: {e}"
    return {
        "status":    "ok",
        "network":   "arc-testnet",
        "storage":   "redis" if USE_REDIS else "ephemeral-file",
        "redis_ok":  redis_ok,
        "agents":    len(registry.all()),
        "tasks":     len(task_store.all()),
        "receipts":  len(receipt_store.all()),
    }

# ── Auth ─────────────────────────────────────────────────────────────────────

@app.post("/api/login")
async def login(req: OnboardRequest):
    """Sign in an existing business by email. Returns 404 if not found."""
    existing = business_store.by_email(req.email)
    if not existing:
        raise HTTPException(status_code=404, detail="No account found for that email. Please create one.")
    try:
        bal = await client.native_balance(existing.wallet_address)
    except Exception:
        bal = 0.0
    return {
        "business_id":    existing.business_id,
        "wallet_address": existing.wallet_address,
        "name":           existing.name,
        "balance_usdc":   bal,
        "existing":       True,
    }

# ── Onboarding ────────────────────────────────────────────────────────────────

@app.post("/api/onboard")
async def onboard(req: OnboardRequest):
    """Create (or retrieve) a Circle DCW wallet for a new business user."""
    existing = business_store.by_email(req.email)
    if existing:
        try:
            bal = await client.native_balance(existing.wallet_address)
        except Exception:
            bal = 0.0
        return {
            "business_id":    existing.business_id,
            "wallet_address": existing.wallet_address,
            "balance_usdc":   bal,
            "existing":       True,
        }

    wallet = provision_agent_wallet(req.name)
    biz    = business_store.create(req.name, req.email, wallet.address, wallet.wallet_id)
    return {
        "business_id":    biz.business_id,
        "wallet_address": wallet.address,
        "balance_usdc":   0.0,
        "existing":       False,
    }

# ── Webhook dispatch ─────────────────────────────────────────────────────────

async def _call_webhook(
    agent,
    task_id:          str,
    description:      str,
    budget_usdc:      float,
    employer_address: str,
    file_context:     str = "",
) -> str:
    """POST task to external agent webhook; return result text."""
    import httpx
    payload = {
        "task_id":          task_id,
        "description":      description + (f"\n\nContext:\n{file_context}" if file_context else ""),
        "budget_usdc":      budget_usdc,
        "employer_address": employer_address,
        "agent_id":         agent.agent_id,
    }
    try:
        async with httpx.AsyncClient(timeout=120) as hc:
            resp = await hc.post(agent.webhook_url, json=payload)
        data = resp.json()
        if isinstance(data, dict):
            return data.get("result") or data.get("output") or str(data)
        return str(data)
    except Exception as exc:
        raise ValueError(f"Webhook call to {agent.webhook_url} failed: {exc}") from exc


# ── Task marketplace ──────────────────────────────────────────────────────────

@app.get("/api/tasks/{task_id}/stream")
async def stream_task_events(task_id: str):
    """SSE endpoint — streams live agent progress for a running task."""
    q: asyncio.Queue = asyncio.Queue()
    _task_streams.setdefault(task_id, []).append(q)

    async def generate():
        try:
            while True:
                try:
                    ev = await asyncio.wait_for(q.get(), timeout=120)
                    yield f"data: {_json_module.dumps(ev)}\n\n"
                    if ev.get("type") in ("done", "error"):
                        break
                except asyncio.TimeoutError:
                    yield 'data: {"type":"ping"}\n\n'
        finally:
            try:
                _task_streams.get(task_id, []).remove(q)
            except ValueError:
                pass

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.post("/api/tasks")
async def post_task(req: PostTaskRequest):
    """Create task immediately and run the agent pipeline in the background."""
    employer_addr = req.employer_address or client.account.address

    task = task_store.create(
        employer_address = employer_addr,
        employer_name    = req.employer_name,
        description      = req.description,
        budget_usdc      = req.budget_usdc,
        deadline_hours   = req.deadline_hours,
    )
    task.status = "in_progress"
    task_store.update(task)

    # Launch pipeline as background task — returns task_id immediately
    asyncio.create_task(_run_pipeline(task, req, employer_addr))
    return {"task_id": task.task_id, "status": "in_progress"}


async def _run_pipeline(task, req, employer_addr: str):
    """Full agent pipeline — runs in background, emits SSE events throughout."""
    import anthropic as _anthropic
    import json as _json
    import re as _re
    tid = task.task_id

    try:
        ai      = _anthropic.AsyncAnthropic(api_key=os.getenv("ANTHROPIC_API_KEY", ""))

        # ── Locate agents ─────────────────────────────────────────────────────
        by_name = {a.name: a for a in registry.all()}

        # ── Build context from all connected data sources ─────────────────
        context_sections: list[str] = []

        # Google Drive files
        if req.drive_files:
            drive_parts = [
                f"=== {f['name']} ===\n{f['content']}"
                for f in req.drive_files
                if f.get("name") and f.get("content")
            ]
            if drive_parts:
                context_sections.append(
                    f"GOOGLE DRIVE FILES ({len(drive_parts)} file{'s' if len(drive_parts) != 1 else ''}):\n\n"
                    + "\n\n".join(drive_parts)
                )

        # Gmail threads
        if req.gmail_threads:
            gmail_parts = [
                f"=== Email: {t['subject']} ===\n{t['content']}"
                for t in req.gmail_threads
                if t.get("subject") and t.get("content")
            ]
            if gmail_parts:
                context_sections.append(
                    f"GMAIL THREADS ({len(gmail_parts)} thread{'s' if len(gmail_parts) != 1 else ''}):\n\n"
                    + "\n\n".join(gmail_parts)
                )

        # Slack messages
        if req.slack_messages:
            slack_parts = [
                f"=== #{m['channel']} ===\n{m['content']}"
                for m in req.slack_messages
                if m.get("channel") and m.get("content")
            ]
            if slack_parts:
                context_sections.append(
                    f"SLACK MESSAGES ({len(slack_parts)} channel{'s' if len(slack_parts) != 1 else ''}):\n\n"
                    + "\n\n".join(slack_parts)
                )

        file_context = (
            "\n\nBUSINESS CONTEXT FROM CONNECTED DATA SOURCES:\n\n"
            + "\n\n---\n\n".join(context_sections)
        ) if context_sections else ""

        employer_key = os.getenv("ARC_PRIVATE_KEY", "")
        task.subtasks = []

        # ── Single-agent path (employer hired a specific agent) ───────────────
        if req.selected_agent:
            agent = by_name.get(req.selected_agent)
            if not agent:
                raise ValueError(f"Agent '{req.selected_agent}' not found in registry")

            await _emit(tid, "agent_start", agent=agent.name, message="Locking USDC in escrow…")

            sub = {
                "agent_name":  agent.name,
                "description": req.description,
                "status":      "locking",
                "job_id":      None,
                "create_tx":   None,
                "settle_tx":   None,
                "result":      None,
            }
            task.subtasks.append(sub)
            task_store.update(task)

            escrow = await client.post_job(
                worker          = agent.payment_addr,
                usdc_amount     = req.budget_usdc,
                timeout_seconds = req.deadline_hours * 3600,
            )
            sub["job_id"]    = escrow["job_id"]
            sub["create_tx"] = escrow["create_tx"]
            sub["status"]    = "working"
            task_store.update(task)
            await _emit(tid, "agent_working", agent=agent.name, message=f"Working on your task…")

            output = await _call_webhook(
                agent,
                task_id          = task.task_id,
                description      = req.description,
                budget_usdc      = req.budget_usdc,
                employer_address = employer_addr,
                file_context     = file_context,
            )

            # Stream output text in chunks
            await _emit(tid, "text_start", agent=agent.name)
            for i in range(0, len(output), 80):
                await _emit(tid, "text_chunk", agent=agent.name, text=output[i:i+80])
                await asyncio.sleep(0.02)

            sub["result"] = output
            task_store.update(task)

            settle_tx        = await client.complete_job(sub["job_id"])
            sub["settle_tx"] = settle_tx
            sub["status"]    = "completed"
            task_store.update(task)
            await _emit(tid, "agent_done", agent=agent.name, message="Complete ✓")

            if employer_key:
                receipt = sign_receipt(
                    job_id          = sub["job_id"],
                    employer_addr   = client.account.address,
                    employer_key    = employer_key,
                    worker_addr     = agent.payment_addr,
                    worker_agent_id = agent.agent_id,
                    task_type       = "task",
                    output_text     = output,
                    amount_usdc     = req.budget_usdc,
                    tx_hash         = settle_tx,
                )
                receipt_store.save(receipt)

            registry.record_completion(agent.agent_id)
            task.result       = output
            task.status       = "completed"
            task.completed_at = int(time.time())
            task_store.update(task)
            await _emit(tid, "done", task_id=tid)
            return

        # ── Multi-agent pipeline (no specific agent selected) ─────────────────
        else:
            market_research_bot = by_name.get("MarketResearchBot")
            sentiment_bot       = by_name.get("SentimentBot")
            portfolio_bot       = by_name.get("PortfolioBot")

            if not all([market_research_bot, sentiment_bot, portfolio_bot]):
                missing = [n for n, a in [("MarketResearchBot", market_research_bot), ("SentimentBot", sentiment_bot), ("PortfolioBot", portfolio_bot)] if not a]
                raise ValueError(f"Required pipeline agents not in registry: {missing}")

            # Step 1: Planner breaks task into 3 sub-tasks
            await _emit(tid, "agent_start", agent="Planner", message="Breaking down your task…")
            plan_resp = await ai.messages.create(
                model      = "claude-haiku-4-5-20251001",
                max_tokens = 600,
                messages   = [{
                    "role":    "user",
                    "content": (
                        f"You are a task planner. Break this client task into 3 focused sub-tasks.\n\n"
                        f"Task: {req.description}"
                        f"{file_context}\n\n"
                        "Return JSON only — no extra text:\n"
                        '{"market_research": "sub-task for MarketResearchBot: gather market intelligence, price trends, sector data", '
                        '"sentiment": "sub-task for SentimentBot: analyse news and social signals, measure market mood", '
                        '"portfolio": "sub-task for PortfolioBot: synthesise findings into portfolio recommendations and risk-adjusted conclusions"}'
                    ),
                }],
            )
            await _emit(tid, "agent_done", agent="Planner", message="Task plan ready ✓")
            raw_plan = plan_resp.content[0].text.strip()
            m        = _re.search(r'\{.*\}', raw_plan, _re.DOTALL)
            try:
                plan = _json.loads(m.group()) if m else {}
            except Exception:
                plan = {}

            sub_descriptions = {
                "MarketResearchBot": plan.get("market_research") or f"Research market intelligence, price trends, and sector data for: {req.description}",
                "SentimentBot":      plan.get("sentiment")       or f"Analyse news and social signals, measure market mood for: {req.description}",
                "PortfolioBot":      plan.get("portfolio")       or f"Synthesise findings into portfolio recommendations and risk-adjusted conclusions for: {req.description}",
            }

            sub_budget = round(req.budget_usdc / 3, 6)
            pipeline   = [
                (market_research_bot, "market_research"),
                (sentiment_bot,       "sentiment"),
                (portfolio_bot,       "portfolio"),
            ]
            agent_outputs: dict[str, str] = {}

            for agent, task_type in pipeline:
                sub_desc = sub_descriptions[agent.name]

                await _emit(tid, "agent_start", agent=agent.name, message=f"Locking {sub_budget:.3f} USDC in escrow…")

                sub = {
                    "agent_name":  agent.name,
                    "description": sub_desc,
                    "status":      "locking",
                    "job_id":      None,
                    "create_tx":   None,
                    "settle_tx":   None,
                    "result":      None,
                }
                task.subtasks.append(sub)
                task_store.update(task)

                escrow = await client.post_job(
                    worker          = agent.payment_addr,
                    usdc_amount     = sub_budget,
                    timeout_seconds = req.deadline_hours * 3600,
                )
                sub["job_id"]    = escrow["job_id"]
                sub["create_tx"] = escrow["create_tx"]
                sub["status"]    = "working"
                task_store.update(task)
                await _emit(tid, "agent_working", agent=agent.name, message="Working…")

                if agent.webhook_url:
                    output = await _call_webhook(
                        agent,
                        task_id          = task.task_id,
                        description      = sub_desc,
                        budget_usdc      = sub_budget,
                        employer_address = employer_addr,
                        file_context     = file_context,
                    )
                else:
                    # Stream Claude output token by token
                    output_parts: list[str] = []
                    await _emit(tid, "text_start", agent=agent.name)
                    async with ai.messages.stream(
                        model      = "claude-opus-4-5",
                        max_tokens = 500,
                        messages   = [{
                            "role":    "user",
                            "content": (
                                f"You are {agent.name}, a specialized AI agent. "
                                f"Complete this sub-task professionally:\n\n{sub_desc}"
                                f"{file_context}"
                            ),
                        }],
                    ) as stream:
                        async for text in stream.text_stream:
                            output_parts.append(text)
                            await _emit(tid, "text_chunk", agent=agent.name, text=text)
                    output = "".join(output_parts)

                sub["result"]             = output
                agent_outputs[agent.name] = output
                task_store.update(task)

                settle_tx        = await client.complete_job(sub["job_id"])
                sub["settle_tx"] = settle_tx
                sub["status"]    = "completed"
                task_store.update(task)
                await _emit(tid, "agent_done", agent=agent.name, message="Complete ✓")

                if employer_key:
                    receipt = sign_receipt(
                        job_id          = sub["job_id"],
                        employer_addr   = client.account.address,
                        employer_key    = employer_key,
                        worker_addr     = agent.payment_addr,
                        worker_agent_id = agent.agent_id,
                        task_type       = task_type,
                        output_text     = output,
                        amount_usdc     = sub_budget,
                        tx_hash         = settle_tx,
                    )
                    receipt_store.save(receipt)

                registry.record_completion(agent.agent_id)

            # Synthesizer combines all three outputs
            await _emit(tid, "agent_start", agent="Synthesizer", message="Combining all outputs into final response…")
            combined = "\n\n".join(f"[{name}]\n{out}" for name, out in agent_outputs.items())
            synth_parts: list[str] = []
            await _emit(tid, "text_start", agent="Synthesizer")
            async with ai.messages.stream(
                model      = "claude-opus-4-5",
                max_tokens = 700,
                messages   = [{
                    "role":    "user",
                    "content": (
                        f"Three specialist agents have completed sub-tasks for a client. "
                        f"Synthesize their outputs into one coherent, professional response.\n\n"
                        f"Original client task: {req.description}\n\n"
                        f"{combined}\n\n"
                        "Write the final unified response now:"
                    ),
                }],
            ) as stream:
                async for text in stream.text_stream:
                    synth_parts.append(text)
                    await _emit(tid, "text_chunk", agent="Synthesizer", text=text)
            task.result = "".join(synth_parts)
            await _emit(tid, "agent_done", agent="Synthesizer", message="Done ✓")

        task.status       = "completed"
        task.completed_at = int(time.time())
        task_store.update(task)
        await _emit(tid, "done", task_id=tid)

    except Exception as e:
        task.status = "refunded"
        task_store.update(task)
        await _emit(tid, "error", message=str(e))


@app.get("/api/tasks")
async def get_tasks():
    return [asdict(t) for t in task_store.all()]


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: str):
    t = task_store.get(task_id)
    if not t:
        raise HTTPException(status_code=404, detail="Task not found")
    return asdict(t)

# ── Analytics (landing page stats) ────────────────────────────────────────────

@app.get("/api/analytics")
async def analytics():
    try:
        jobs      = await client.get_all_jobs()
        completed = [j for j in jobs if j.status == "Completed"]
        agents    = registry.all()
        tasks     = task_store.all()

        return {
            "metrics": {
                "totalJobsCompleted": len(completed),
                "usdcSettled":        round(sum(j.amount_usdc for j in completed), 2),
                "activeAgents":       len(agents),
                "totalTasks":         len(tasks),
            },
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Slack OAuth callback ──────────────────────────────────────────────────────

@app.get("/oauth/slack/callback")
async def slack_oauth_callback(code: str = "", error: str = ""):
    """Exchange Slack OAuth code for access token, redirect back to the frontend dashboard."""
    import httpx
    from fastapi.responses import RedirectResponse

    frontend = os.getenv("FRONTEND_URL", "http://localhost:5173")

    if error or not code:
        return RedirectResponse(url=f"{frontend}/dashboard?slack_error=1")

    slack_client_id     = os.getenv("SLACK_CLIENT_ID", "")
    slack_client_secret = os.getenv("SLACK_CLIENT_SECRET", "")

    if not slack_client_id or not slack_client_secret:
        return RedirectResponse(url=f"{frontend}/dashboard?slack_connected=1")

    try:
        async with httpx.AsyncClient() as hc:
            resp = await hc.post("https://slack.com/api/oauth.v2.access", data={
                "client_id":     slack_client_id,
                "client_secret": slack_client_secret,
                "code":          code,
            })
        data = resp.json()
        if not data.get("ok"):
            return RedirectResponse(url=f"{frontend}/dashboard?slack_error=1")
        os.environ["SLACK_BOT_TOKEN"] = data.get("access_token", "")
        return RedirectResponse(url=f"{frontend}/dashboard?slack_connected=1")
    except Exception:
        return RedirectResponse(url=f"{frontend}/dashboard?slack_error=1")

# ── Wallet ─────────────────────────────────────────────────────────────────────

@app.get("/api/wallet")
async def get_wallet():
    addr         = os.getenv("CIRCLE_WALLET_ADDRESS", "")
    balance_usdc = 0.0
    if client and addr:
        try:
            balance_usdc = await client.native_balance(addr)
        except Exception:
            pass
    return {"address": addr, "balance_usdc": round(balance_usdc, 4), "network": "arc-testnet"}

# ── Agents ─────────────────────────────────────────────────────────────────────

@app.get("/api/agents")
async def get_agents():
    return registry.to_dict()

@app.post("/api/agents/register")
async def register_agent(req: RegisterAgentRequest):
    import hashlib
    agent_id = hashlib.sha256(f"{req.payment_addr.lower()}:{req.name.lower()}".encode()).hexdigest()[:16]
    existing = registry.get(agent_id)
    if existing:
        raise HTTPException(status_code=409, detail="An agent with this name and wallet already exists.")
    card = registry.register(
        name         = req.name,
        owner        = req.payment_addr,
        payment_addr = req.payment_addr,
        capabilities = req.capabilities,
        endpoint     = f"{os.getenv('RENDER_EXTERNAL_URL', 'http://localhost:8000')}/agents/{agent_id}",
        webhook_url  = req.webhook_url,
    )
    import dataclasses
    d = dataclasses.asdict(card)
    d["price_per_task"] = req.price_per_task
    d["description"]    = req.description
    return d

# ── Jobs (raw on-chain) ────────────────────────────────────────────────────────

@app.get("/api/jobs")
async def get_all_jobs():
    try:
        return [j.__dict__ for j in await client.get_all_jobs()]
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ── Receipts ──────────────────────────────────────────────────────────────────

@app.get("/api/receipts")
async def get_receipts():
    return [r.to_dict() for r in receipt_store.all()]


@app.get("/api/receipts/{receipt_id}/verify")
async def verify_receipt(receipt_id: str):
    r = receipt_store.get(receipt_id)
    if not r:
        raise HTTPException(status_code=404, detail="Receipt not found")
    return {"receipt_id": receipt_id, "valid": r.verify(), "signer": r.employer}

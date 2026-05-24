"""
Brewing Agent Registry — Pillar A: ACP Discovery
=================================================
In-memory registry of Agent Cards. Each card declares:
  - owner address (human principal)
  - capabilities (what the agent can do)
  - payment address (where to send USDC)
  - MCP/A2A endpoint
  - on-chain reputation (computed from AgentEscrow history)

In production this would be an on-chain ERC-8004 registry.
For the hackathon, it's a persistent in-process store backed
by on-chain job history from AgentEscrow.vy.
"""
from __future__ import annotations

import hashlib
import json
import time
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Optional

REGISTRY_FILE = Path(__file__).parent.parent / "agent_registry.json"


# ── Agent Card (ERC-8004 inspired) ────────────────────────────────────────────

@dataclass
class AgentCard:
    agent_id:       str          # deterministic: sha256(owner+name)
    name:           str          # human-readable identifier
    owner:          str          # Arc wallet address (human principal)
    payment_addr:   str          # where USDC lands
    capabilities:   list[str]    # e.g. ["research", "analysis", "strategy"]
    endpoint:       str          # MCP/A2A endpoint
    registered_at:  int          # unix timestamp
    # reputation fields — updated from on-chain data
    jobs_completed: int   = 0
    jobs_slashed:   int   = 0
    jobs_total:     int   = 0
    reputation:     float = 0.0  # 0–10000 bps composite score
    active:         bool  = True


def _make_id(owner: str, name: str) -> str:
    raw = f"{owner.lower()}:{name.lower()}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ── Reputation formula (from positioning doc) ─────────────────────────────────

def compute_reputation(
    jobs_completed: int,
    jobs_slashed:   int,
    jobs_total:     int,
    chains:         int = 1,     # diversity bonus — chains settled on
) -> float:
    """
    finalScore = (baseScore × volumeMultiplier / 10000) + diversityBonus - slashPenalty

    baseScore (0–7000):   positive / negative peer ratings proxy → completion ratio
    volumeMultiplier:     log2 scale — thin records penalised
    diversityBonus:       500 bps per chain, max 2000
    slashPenalty:         1500 bps per slash event
    """
    if jobs_total == 0:
        return 0.0

    # Base score: 0–7000 from completion ratio
    completion_ratio = jobs_completed / jobs_total
    base_score = completion_ratio * 7000

    # Volume multiplier: 5000 + log2(count)*500, capped 5000–10000
    import math
    volume_multiplier = min(10000, 5000 + math.log2(max(1, jobs_total)) * 500)

    # Diversity bonus: 500 per chain, max 2000
    diversity_bonus = min(2000, chains * 500)

    # Slash penalty: 1500 per breach
    slash_penalty = jobs_slashed * 1500

    raw = (base_score * volume_multiplier / 10000) + diversity_bonus - slash_penalty
    return round(max(0.0, min(10000.0, raw)), 2)


# ── Registry ──────────────────────────────────────────────────────────────────

class AgentRegistry:
    """
    In-memory agent directory. Populated at startup, updated
    as jobs complete/slash on-chain.
    """

    def __init__(self):
        self._cards: dict[str, AgentCard] = {}

    # ── Registration ──────────────────────────────────────────────────────────

    def register(
        self,
        name:         str,
        owner:        str,
        payment_addr: str,
        capabilities: list[str],
        endpoint:     str = "http://localhost:8000/agents/{id}",
    ) -> AgentCard:
        agent_id = _make_id(owner, name)
        card = AgentCard(
            agent_id      = agent_id,
            name          = name,
            owner         = owner,
            payment_addr  = payment_addr,
            capabilities  = capabilities,
            endpoint      = endpoint.replace("{id}", agent_id),
            registered_at = int(time.time()),
        )
        self._cards[agent_id] = card
        self.save()
        return card

    # ── Discovery (Pillar A: ACP) ─────────────────────────────────────────────

    def find(self, capability: str) -> list[AgentCard]:
        """Return active agents that match a capability, ranked by reputation."""
        matches = [
            c for c in self._cards.values()
            if c.active and any(capability.lower() in cap.lower() for cap in c.capabilities)
        ]
        return sorted(matches, key=lambda c: c.reputation, reverse=True)

    def get(self, agent_id: str) -> Optional[AgentCard]:
        return self._cards.get(agent_id)

    def all(self) -> list[AgentCard]:
        return sorted(self._cards.values(), key=lambda c: c.reputation, reverse=True)

    # ── Reputation update (called after on-chain settlement) ──────────────────

    def record_completion(self, agent_id: str):
        if card := self._cards.get(agent_id):
            card.jobs_completed += 1
            card.jobs_total     += 1
            card.reputation = compute_reputation(
                card.jobs_completed, card.jobs_slashed, card.jobs_total
            )
            self.save()

    def record_slash(self, agent_id: str):
        if card := self._cards.get(agent_id):
            card.jobs_slashed += 1
            card.jobs_total   += 1
            card.reputation = compute_reputation(
                card.jobs_completed, card.jobs_slashed, card.jobs_total
            )
            self.save()

    def record_job(self, agent_id: str):
        if card := self._cards.get(agent_id):
            card.jobs_total += 1
            card.reputation = compute_reputation(
                card.jobs_completed, card.jobs_slashed, card.jobs_total
            )
            self.save()

    # ── Persistence ───────────────────────────────────────────────────────────

    def save(self):
        """Write registry to disk so agent cards survive restarts."""
        data = {aid: asdict(card) for aid, card in self._cards.items()}
        REGISTRY_FILE.write_text(json.dumps(data, indent=2))

    def load(self):
        """Restore registry from disk if it exists."""
        if not REGISTRY_FILE.exists():
            return
        try:
            data = json.loads(REGISTRY_FILE.read_text())
            for aid, d in data.items():
                self._cards[aid] = AgentCard(**d)
        except Exception:
            pass  # corrupt file — start fresh

    def to_dict(self) -> list[dict]:
        return [asdict(c) for c in self.all()]


# ── Global singleton ──────────────────────────────────────────────────────────

registry = AgentRegistry()
registry.load()   # restore cards from previous session on import

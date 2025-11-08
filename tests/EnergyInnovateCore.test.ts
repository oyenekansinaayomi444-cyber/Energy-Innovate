// tests/EnergyInnovateCore.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const ERR_NOT_AUTHORIZED = 100;
const ERR_NOT_FOUND = 102;
const ERR_INVALID_HASH = 103;
const ERR_INVALID_CATEGORY = 104;
const ERR_EXPERT_ONLY = 107;
const ERR_VERIFICATION_CLOSED = 108;
const ERR_ALREADY_VOTED = 110;
const ERR_ACCESS_DENIED = 112;

interface Idea {
  title: string;
  description: string;
  "file-hash": Uint8Array;
  category: bigint;
  submitter: string;
  timestamp: bigint;
  status: string;
  "access-count": bigint;
}

class CoreMock {
  state = {
    nextIdeaId: 0n,
    platformOwner: "ST1OWNER",
    totalFeesCollected: 0n,
    ideas: new Map<number, Idea>(),
    ideaExperts: new Map<number, string[]>(),
    expertVotes: new Map<string, { approve: boolean; reasoning: string }>(),
    expertReputation: new Map<string, number>(),
    royaltiesPending: new Map<string, number>(),
  };
  caller = "ST1SUBMITTER";
  blockHeight = 100n;

  constructor() {
    this.reset();
  }

  reset() {
    this.state = {
      nextIdeaId: 0n,
      platformOwner: "ST1OWNER",
      totalFeesCollected: 0n,
      ideas: new Map(),
      ideaExperts: new Map(),
      expertVotes: new Map(),
      expertReputation: new Map(),
      royaltiesPending: new Map(),
    };
    this.caller = "ST1SUBMITTER";
    this.blockHeight = 100n;
  }

  registerExpert() {
    this.state.expertReputation.set(this.caller, 50);
    return { ok: true, value: true };
  }

  submitIdea(
    title: string,
    description: string,
    fileHash: Uint8Array,
    category: number
  ) {
    if (fileHash.length !== 32) return { ok: false, value: ERR_INVALID_HASH };
    if (category < 1 || category > 5)
      return { ok: false, value: ERR_INVALID_CATEGORY };
    const id = Number(this.state.nextIdeaId);
    const idea: Idea = {
      title,
      description,
      "file-hash": fileHash,
      category: BigInt(category),
      submitter: this.caller,
      timestamp: this.blockHeight,
      status: "pending",
      "access-count": 0n,
    };
    this.state.ideas.set(id, idea);
    this.state.nextIdeaId += 1n;
    return { ok: true, value: id };
  }

  assignExperts(ideaId: number, experts: string[]) {
    if (this.caller !== this.state.platformOwner)
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    const idea = this.state.ideas.get(ideaId);
    if (!idea || idea.status !== "pending")
      return { ok: false, value: ERR_VERIFICATION_CLOSED };
    this.state.ideaExperts.set(ideaId, experts);
    return { ok: true, value: true };
  }

  verifyIdea(ideaId: number, approve: boolean, reasoning: string) {
    const rep = this.state.expertReputation.get(this.caller) || 0;
    if (rep < 50) return { ok: false, value: ERR_EXPERT_ONLY };
    const experts = this.state.ideaExperts.get(ideaId) || [];
    if (!experts.includes(this.caller))
      return { ok: false, value: ERR_NOT_AUTHORIZED };
    const idea = this.state.ideas.get(ideaId);
    if (!idea || idea.status !== "pending")
      return { ok: false, value: ERR_VERIFICATION_CLOSED };
    const key = `${ideaId}-${this.caller}`;
    if (this.state.expertVotes.has(key))
      return { ok: false, value: ERR_ALREADY_VOTED };
    this.state.expertVotes.set(key, { approve, reasoning });
    const approvals = experts.filter(
      (e) => this.state.expertVotes.get(`${ideaId}-${e}`)?.approve
    ).length;
    if (approvals * 100 >= experts.length * 70) {
      idea.status = approve ? "verified" : "rejected";
      if (approve) this.distributeRoyalty(ideaId, experts);
      return { ok: true, value: true };
    }
    return { ok: true, value: false };
  }

  accessIdea(ideaId: number) {
    const idea = this.state.ideas.get(ideaId);
    if (!idea || idea.status !== "verified")
      return { ok: false, value: ERR_ACCESS_DENIED };
    this.state.totalFeesCollected += 1000000n;
    idea["access-count"] += 1n;
    const experts = this.state.ideaExperts.get(ideaId) || [];
    this.distributeRoyalty(ideaId, experts);
    return { ok: true, value: true };
  }

  private distributeRoyalty(ideaId: number, experts: string[]) {
    const perExpert = (1000000 * 10) / 100;
    for (const e of experts) {
      const pending = this.state.royaltiesPending.get(e) || 0;
      this.state.royaltiesPending.set(e, pending + perExpert);
    }
  }

  getIdea(id: number) {
    return this.state.ideas.get(id) || null;
  }

  getRoyalties(expert: string) {
    return this.state.royaltiesPending.get(expert) || 0;
  }
}

describe("EnergyInnovateCore", () => {
  let core: CoreMock;

  beforeEach(() => {
    core = new CoreMock();
    core.reset();
  });

  it("submits idea successfully", () => {
    const hash = new Uint8Array(32).fill(1);
    const result = core.submitIdea("Solar Mesh", "Self-healing grid", hash, 1);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const idea = core.getIdea(0);
    expect(idea?.title).toBe("Solar Mesh");
    expect(idea?.status).toBe("pending");
  });

  it("rejects invalid hash", () => {
    const bad = new Uint8Array(31);
    const result = core.submitIdea("Bad", "desc", bad, 1);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_HASH);
  });

  it("registers and assigns experts", () => {
    core.caller = "ST1EXPERT1";
    core.registerExpert();
    core.caller = "ST1OWNER";
    core.submitIdea("Test", "desc", new Uint8Array(32).fill(2), 2);
    const assign = core.assignExperts(0, [
      "ST1EXPERT1",
      "ST1EXPERT2",
      "ST1EXPERT3",
    ]);
    expect(assign.ok).toBe(true);
  });

  it("verifies idea with quorum", () => {
    core.caller = "ST1EXPERT1";
    core.registerExpert();
    core.caller = "ST1EXPERT2";
    core.registerExpert();
    core.caller = "ST1EXPERT3";
    core.registerExpert();
    core.caller = "ST1OWNER";
    core.submitIdea("Quorum", "test", new Uint8Array(32).fill(3), 1);
    core.assignExperts(0, ["ST1EXPERT1", "ST1EXPERT2", "ST1EXPERT3"]);
    core.caller = "ST1EXPERT1";
    core.verifyIdea(0, true, "good");
    core.caller = "ST1EXPERT2";
    core.verifyIdea(0, true, "great");
    core.caller = "ST1EXPERT3";
    const final = core.verifyIdea(0, true, "excellent");
    expect(final.ok).toBe(true);
    expect(final.value).toBe(true);
    expect(core.getIdea(0)?.status).toBe("verified");
  });

  it("blocks non-experts", () => {
    core.caller = "ST1HACKER";
    core.submitIdea("Hack", "bad", new Uint8Array(32).fill(5), 1);
    core.caller = "ST1OWNER";
    core.assignExperts(0, ["ST1EXPERT1"]);
    core.caller = "ST1HACKER";
    const vote = core.verifyIdea(0, true, "fake");
    expect(vote.ok).toBe(false);
    expect(vote.value).toBe(ERR_EXPERT_ONLY);
  });
});

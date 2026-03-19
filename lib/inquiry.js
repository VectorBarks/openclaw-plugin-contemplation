const fs = require('fs');
const path = require('path');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function readJson(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

class InquiryStore {
  constructor(baseDir, agentId, passesConfig, priorityConfig) {
    this.agentId = agentId || 'main';
    this.passesConfig = passesConfig || {};
    this.priorityConfig = priorityConfig || {};
    this.agentDir = path.join(baseDir, 'agents', this.agentId);
    this.filePath = path.join(this.agentDir, 'inquiries.json');
    ensureDir(this.agentDir);
    this.state = readJson(this.filePath, { inquiries: [] });
  }

  persist() {
    ensureDir(this.agentDir);
    fs.writeFileSync(this.filePath, JSON.stringify(this.state, null, 2));
  }

  list() {
    return this.state.inquiries;
  }

  /**
   * Calculate priority for an inquiry based on source, tags, and entropy.
   * Explicit priority parameter overrides auto-calculation.
   */
  _calculatePriority({ source, tags, entropy, explicitPriority }) {
    if (typeof explicitPriority === 'number') return explicitPriority;

    const pc = this.priorityConfig;
    const src = (source || '').toLowerCase();
    const tagList = Array.isArray(tags) ? tags.map(t => t.toLowerCase()) : [];

    // Correction source gets highest priority
    if (src.includes('correction')) {
      return pc.correction ?? 200;
    }

    // Manual source or manual tag
    if (src.includes('manual') || tagList.includes('manual')) {
      return pc.manual ?? 100;
    }

    // Entropy-based scoring with default fallback
    const base = pc.defaultPriority ?? 0;
    const multiplier = pc.entropyMultiplier ?? 10;
    const ent = Number.isFinite(entropy) ? entropy : 0;
    return Math.round(base + (ent * multiplier));
  }

  addInquiry({ question, source, entropy, context, priority, tags }) {
    // Dedup: skip if identical question already in_progress (compare first 80 chars)
    const qKey = (question || '').slice(0, 80);
    const existing = this.state.inquiries.find(
      i => i.status === 'in_progress' && (i.question || '').slice(0, 80) === qKey
    );
    if (existing) return existing;

    const createdMs = Date.now();
    const id = `inq_${Math.random().toString(36).slice(2, 10)}`;
    const pass1Delay = this.passesConfig['1']?.delayMs || 0;

    const calculatedPriority = this._calculatePriority({
      source,
      tags,
      entropy,
      explicitPriority: priority
    });

    const inquiry = {
      id,
      question,
      source: source || 'agent_end',
      entropy: Number.isFinite(entropy) ? entropy : 0,
      context: context || '',
      priority: calculatedPriority,
      passes: [
        {
          number: 1,
          scheduled: iso(createdMs + pass1Delay),
          completed: null,
          output: null
        },
        {
          number: 2,
          scheduled: null,
          completed: null,
          output: null
        },
        {
          number: 3,
          scheduled: null,
          completed: null,
          output: null
        }
      ],
      tags: tags || [],
      status: 'in_progress',
      created: iso(createdMs),
      persisted: false
    };

    this.state.inquiries.push(inquiry);
    this.persist();
    return inquiry;
  }

  /**
   * Get the next due pass, ordered by inquiry priority (desc) then scheduled time (asc).
   * Returns highest-priority pending pass first.
   */
  getDuePass(nowMs = Date.now(), forceRun = false) {
    const eligible = [];

    for (const inquiry of this.state.inquiries) {
      if (inquiry.status !== 'in_progress') continue;
      for (const p of inquiry.passes) {
        if (!p.scheduled || p.completed) continue;
        if (forceRun || Date.parse(p.scheduled) <= nowMs) {
          eligible.push({ inquiry, passNumber: p.number, scheduled: Date.parse(p.scheduled) });
        }
      }
    }

    if (eligible.length === 0) return null;

    // Sort: highest priority first, then earliest scheduled (FIFO fallback)
    eligible.sort((a, b) => {
      const priDiff = (b.inquiry.priority || 0) - (a.inquiry.priority || 0);
      if (priDiff !== 0) return priDiff;
      return a.scheduled - b.scheduled;
    });

    return { inquiry: eligible[0].inquiry, passNumber: eligible[0].passNumber };
  }

  completePass(inquiryId, passNumber, output) {
    const inquiry = this.state.inquiries.find(i => i.id === inquiryId);
    if (!inquiry) return null;

    const pass = inquiry.passes.find(p => p.number === passNumber);
    if (!pass) return null;

    pass.completed = new Date().toISOString();
    pass.output = output;

    const nextPassNumber = passNumber + 1;
    const nextPass = inquiry.passes.find(p => p.number === nextPassNumber);
    if (nextPass) {
      const delayMs = this.passesConfig[String(nextPassNumber)]?.delayMs || 0;
      nextPass.scheduled = new Date(Date.now() + delayMs).toISOString();
    } else {
      inquiry.status = 'completed';
      inquiry.completed = new Date().toISOString();
    }

    this.persist();
    return inquiry;
  }

  getCompletedUnpersisted() {
    return this.state.inquiries.filter(i => i.status === 'completed' && !i.persisted);
  }

  markPersisted(inquiryId) {
    const inquiry = this.state.inquiries.find(i => i.id === inquiryId);
    if (!inquiry) return false;
    inquiry.persisted = true;
    this.persist();
    return true;
  }
}

module.exports = InquiryStore;

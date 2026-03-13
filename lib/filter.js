/**
 * Hybrid Classifier Filter for Contemplation Inquiries
 * 
 * Runs on every new inquiry BEFORE it enters the queue.
 * Stage 1: Regex/heuristics for obvious patterns (fast)
 * Stage 2: LLM fallback if confidence < threshold
 * 
 * Blocked inquiries are logged to JSONL for review.
 */

const fs = require('fs');
const path = require('path');

// ── Stage 1: Regex/Heuristic Classifiers ──────────────────────────────────

const TOOL_PATTERN = /^(git|npm|docker|kubectl|brew|pip|cargo|webpack|eslint|prettier|jq|curl|wget|ssh|scp|rsync|tmux|vim|nano|grep|awk|sed|cat|ls|cd|mkdir|rm|cp|mv|find|tar|zip|unzip|node|python|ruby|go|rust|java|kotlin|swift|flutter|react|vue|angular|nextjs|fastapi|django|flask|express|prisma|supabase|firebase|vercel|netlify|aws|gcp|azure|terraform|ansible|k8s|helm|grafana|prometheus|loki|jaeger|redis|postgres|mysql|mongo|sqlite|elasticsearch|rabbitmq|kafka|nginx|caddy|traefik|haproxy|ollama|vllm|mlx|gguf|llamacpp|openai|anthropic|mistral|groq|replicate|huggingface|langchain|llama_?index|autogen|crewai|semantic.kernel|chromadb|pinecone|weaviate|qdrant|milvus|faiss|annoy|dspy|outlines|guidance|lmql|openrouter|together\.?ai|anyscale|modal|runpod|cloudflare|hetzner|digitalocean|linode|ovh|scaleway|contabo|paperspace)$/i;

const PERSON_NAME_PATTERN = /^[A-ZÄÖÜ][a-zäöüß]{1,14}(\s+[A-ZÄÖÜ][a-zäöüß]{1,14})?$/;

const ADDRESS_FORM_PATTERN = /^(herr|frau|mr|mrs|ms|dr|prof|sir|ma'?am|boss|chief|buddy|dude|bro|sis|sweetie|honey|darling|liebe[rs]?|schatz|mein[e]?|daddy|mommy|papa|mama)$/i;

const SELF_REFERENCE_PATTERN = /^(i am|who am i|my name|mein name|ich bin|wer bin ich)$/i;

/**
 * Check if a question looks like a graph frequency artifact:
 * - Very short (< 20 chars)
 * - No question mark
 * - No verb structure (no spaces or just 1-2 words)
 * - Not a real question
 */
function isGraphArtifact(question) {
  const trimmed = question.trim();
  if (trimmed.length > 25) return false;
  if (trimmed.includes('?')) return false;
  const words = trimmed.split(/\s+/);
  if (words.length > 3) return false;
  // Single word or very short phrase without question structure
  if (words.length === 1 && trimmed.length < 20) return true;
  // Two words, both short, no verb indicators
  if (words.length <= 2 && !/\b(ist|are|is|was|wie|how|why|warum|what|wer|wo|where|when|wann|does|kann|can|should|soll)\b/i.test(trimmed)) {
    return true;
  }
  return false;
}

/**
 * Stage 1: Regex/heuristic classification
 * Returns { blocked, confidence, reason, category }
 */
function classifyRegex(question, blockCategories) {
  const trimmed = question.trim();
  const categories = new Set(blockCategories || []);

  if (categories.has('tool_or_app_name') && TOOL_PATTERN.test(trimmed)) {
    return { blocked: true, confidence: 0.95, reason: `Tool/app name: "${trimmed}"`, category: 'tool_or_app_name' };
  }

  if (categories.has('address_form') || categories.has('nickname_or_address_form')) {
    if (ADDRESS_FORM_PATTERN.test(trimmed)) {
      return { blocked: true, confidence: 0.9, reason: `Address form: "${trimmed}"`, category: 'nickname_or_address_form' };
    }
  }

  if (categories.has('agent_self_reference') && SELF_REFERENCE_PATTERN.test(trimmed)) {
    return { blocked: true, confidence: 0.85, reason: `Self-reference: "${trimmed}"`, category: 'agent_self_reference' };
  }

  if (categories.has('graph_frequency_artifact') && isGraphArtifact(trimmed)) {
    return { blocked: true, confidence: 0.7, reason: `Graph artifact: "${trimmed}"`, category: 'graph_frequency_artifact' };
  }

  if (categories.has('person_name') && PERSON_NAME_PATTERN.test(trimmed)) {
    // Lower confidence — could be a real question about a person
    return { blocked: true, confidence: 0.6, reason: `Possible person name: "${trimmed}"`, category: 'person_name' };
  }

  return { blocked: false, confidence: 0, reason: '', category: '' };
}

/**
 * Stage 2: LLM classification fallback
 */
async function classifyLLM(question, config, callLLM) {
  const prompt = [
    'Is this a genuine knowledge gap or contemplative question worth thinking about over time,',
    'or is it noise (a person name, tool name, address form, self-reference, or graph topology artifact)?',
    '',
    `Question: "${question}"`,
    '',
    'Reply with ONLY valid JSON: {"isNoise": true/false, "category": "person_name|tool_or_app_name|nickname_or_address_form|agent_self_reference|graph_frequency_artifact|genuine", "confidence": 0.0-1.0}'
  ].join('\n');

  try {
    const result = await callLLM({
      endpoint: config.llm?.endpoint || 'http://localhost:8080/v1/chat/completions',
      model: config.llm?.model,
      prompt,
      temperature: 0.2,
      maxTokens: 150,
      timeoutMs: config.llm?.timeoutMs ?? 15000,
      apiKey: config.llm?.apiKey || null,
      format: config.llm?.format || null
    });

    const match = result.match(/\{[^}]+\}/s);
    if (match) {
      const parsed = JSON.parse(match[0]);
      return {
        blocked: !!parsed.isNoise,
        confidence: Number(parsed.confidence || 0.5),
        reason: `LLM classified as ${parsed.category || 'unknown'}`,
        category: parsed.category || 'unknown'
      };
    }
  } catch (err) {
    // LLM failed — don't block on uncertainty
    return { blocked: false, confidence: 0, reason: `LLM fallback failed: ${err.message}`, category: '' };
  }

  return { blocked: false, confidence: 0, reason: 'LLM response unparseable', category: '' };
}

/**
 * Log a blocked inquiry to JSONL file
 */
function logBlocked(question, result, config) {
  if (!config.filter?.logBlocked) return;

  const logPath = path.resolve(__dirname, '..', config.filter.blockedLogPath || 'blocked-inquiries.jsonl');
  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    question,
    category: result.category,
    confidence: result.confidence,
    stage: result.stage || 'regex',
    reason: result.reason
  });

  try {
    fs.appendFileSync(logPath, entry + '\n');
  } catch (err) {
    // Silent fail — logging shouldn't break the pipeline
  }
}

/**
 * Main filter function — should be called before addInquiry()
 * 
 * @param {string} question - The inquiry question text
 * @param {object} config - Full plugin config (needs filter.* and llm.*)
 * @param {function} callLLM - The callLLM function from reflect.js
 * @returns {Promise<{blocked: boolean, reason: string, category: string}>}
 */
async function shouldBlock(question, config, callLLM) {
  if (!config.filter?.enabled) {
    return { blocked: false, reason: 'filter disabled', category: '' };
  }

  // Stage 1: Regex/heuristics
  const regexResult = classifyRegex(question, config.filter.blockCategories);

  if (regexResult.blocked && regexResult.confidence >= (config.filter.llmFallbackThreshold || 0.5)) {
    regexResult.stage = 'regex';
    logBlocked(question, regexResult, config);
    return regexResult;
  }

  // Stage 2: LLM fallback (if regex confidence below threshold or not blocked)
  if (regexResult.confidence > 0 && regexResult.confidence < (config.filter.llmFallbackThreshold || 0.5)) {
    if (callLLM) {
      const llmResult = await classifyLLM(question, config, callLLM);
      llmResult.stage = 'llm';
      if (llmResult.blocked) {
        logBlocked(question, llmResult, config);
      }
      return llmResult;
    }
  }

  // Not blocked by either stage
  if (regexResult.blocked) {
    // Regex said block but low confidence and no LLM available — block anyway
    regexResult.stage = 'regex';
    logBlocked(question, regexResult, config);
    return regexResult;
  }

  return { blocked: false, reason: '', category: '' };
}

module.exports = {
  shouldBlock,
  classifyRegex,
  classifyLLM,
  logBlocked
};

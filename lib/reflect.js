function buildPrompt({ inquiry, passNumber, passPrompt }) {
  const prior = (inquiry.passes || [])
    .filter(p => p.number < passNumber && p.completed && p.output)
    .map(p => `Pass ${p.number} output:\n${p.output}`)
    .join('\n\n');

  return [
    'You are running a contemplative pass over a single inquiry.',
    `Pass: ${passNumber}`,
    `Instruction: ${passPrompt}`,
    `Inquiry: ${inquiry.question}`,
    `Source: ${inquiry.source}`,
    `Context:\n${inquiry.context || '(none)'}`,
    prior ? `Prior passes:\n${prior}` : 'Prior passes: (none)',
    'Return concise but specific reflection text only.'
  ].join('\n\n');
}

/**
 * Detect API format from endpoint URL.
 * - Endpoints containing '/api/generate' or '/api/chat' → Ollama native
 * - Everything else → OpenAI-compatible (works with Ollama /v1/, OpenRouter, Modal, etc.)
 */
function detectFormat(endpoint) {
  if (/\/api\/(generate|chat)\b/.test(endpoint)) return 'ollama';
  if (/anthropic\.com/.test(endpoint)) return 'anthropic';
  return 'openai';
}

/**
 * Call an LLM endpoint using the appropriate format.
 * Supports:
 *   - OpenAI-compatible: /v1/chat/completions (Ollama, OpenRouter, Modal, vLLM, etc.)
 *   - Ollama native: /api/generate (legacy backward compat)
 */
async function callLLM({ endpoint, model, prompt, temperature, maxTokens, timeoutMs, apiKey, format }) {
  const resolvedFormat = format || detectFormat(endpoint);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 45000);

  // Resolve env: prefixed API keys
  const resolvedApiKey = apiKey?.startsWith('env:')
    ? process.env[apiKey.slice(4)] || null
    : apiKey;

  const headers = { 'Content-Type': 'application/json' };
  if (resolvedFormat === 'anthropic') {
    if (resolvedApiKey) headers['x-api-key'] = resolvedApiKey;
    headers['anthropic-version'] = '2023-06-01';
  } else if (resolvedApiKey) {
    headers['Authorization'] = `Bearer ${resolvedApiKey}`;
  }

  try {
    let body;
    if (resolvedFormat === 'ollama') {
      // Legacy Ollama /api/generate format
      body = JSON.stringify({
        model,
        prompt,
        stream: false,
        options: {
          temperature,
          num_predict: maxTokens
        }
      });
    } else {
      // OpenAI-compatible /v1/chat/completions format
      if (resolvedFormat === 'anthropic') {
      body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
      });
    } else {
      body = JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
        stream: false
      });
    }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`LLM request failed (${res.status}): ${errText.substring(0, 200)}`);
    }

    const payload = await res.json();

    if (resolvedFormat === 'anthropic') {
      // Anthropic returns { content: [{ type: "text", text: "..." }] }
      const text = payload?.content?.find(b => b.type === 'text')?.text?.trim();
      if (text) return text;
      throw new Error('Anthropic response missing content text');
    } else if (resolvedFormat === 'ollama') {
      // Ollama native returns { response: "..." }
      if (typeof payload?.response === 'string' && payload.response.trim()) {
        return payload.response.trim();
      }
      throw new Error('Ollama response missing "response" text');
    } else {
      // OpenAI-compatible returns { choices: [{ message: { content: "..." } }] }
      const msg = payload?.choices?.[0]?.message;
      // reasoning fallback: GLM returns output in reasoning field when content is empty
      const text = (typeof msg?.content === 'string' && msg.content.trim()) ? msg.content.trim()
                 : (typeof msg?.reasoning === 'string' && msg.reasoning.trim()) ? msg.reasoning.trim()
                 : null;
      if (text) return text;
      throw new Error('LLM response missing choices[0].message.content');
    }
  } finally {
    clearTimeout(timer);
  }
}

async function runPass({ inquiry, passNumber, config }) {
  const passPrompt = config.passes?.[String(passNumber)]?.prompt || `Pass ${passNumber}`;
  const prompt = buildPrompt({ inquiry, passNumber, passPrompt });

  return callLLM({
    endpoint: config.llm?.endpoint || 'http://localhost:8080/v1/chat/completions',
    model: config.llm?.model,
    prompt,
    temperature: config.llm?.temperature ?? 0.6,
    maxTokens: config.llm?.maxTokens ?? 700,
    timeoutMs: config.llm?.timeoutMs ?? 45000,
    apiKey: config.llm?.apiKey || null,
    format: config.llm?.format || null
  });
}

module.exports = {
  runPass,
  buildPrompt,
  callLLM,
  // Backward compat — callOllama now delegates to callLLM
  callOllama: callLLM
};

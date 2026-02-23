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

async function callOllama({ endpoint, model, prompt, temperature, maxTokens, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs || 45000);

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        temperature,
        max_tokens: maxTokens,
        stream: false
      }),
      signal: controller.signal
    });

    if (!res.ok) {
      throw new Error(`MLX request failed (${res.status})`);
    }

    const payload = await res.json();
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text === 'string' && text.trim()) {
      return text.trim();
    }

    throw new Error('MLX response missing choices[0].message.content');
  } finally {
    clearTimeout(timer);
  }
}

async function runPass({ inquiry, passNumber, config }) {
  const passPrompt = config.passes?.[String(passNumber)]?.prompt || `Pass ${passNumber}`;
  const prompt = buildPrompt({ inquiry, passNumber, passPrompt });

  return callOllama({
    endpoint: config.llm?.endpoint || 'http://localhost:8080/v1/chat/completions',
    model: config.llm?.model,
    prompt,
    temperature: config.llm?.temperature ?? 0.6,
    maxTokens: config.llm?.maxTokens ?? 700,
    timeoutMs: config.llm?.timeoutMs ?? 45000
  });
}

module.exports = {
  runPass,
  buildPrompt,
  callOllama
};

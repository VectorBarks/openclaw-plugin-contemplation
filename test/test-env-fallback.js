#!/usr/bin/env node
/**
 * Test that env:ANTHROPIC_API_KEY resolves correctly from ~/.openclaw/.env
 * when process.env doesn't have it (Gateway process scenario)
 */

const { callLLM } = require('../lib/reflect.js');

async function test() {
  console.log('Testing env:ANTHROPIC_API_KEY fallback to ~/.openclaw/.env...\n');

  // Simulate Gateway process: ensure ANTHROPIC_API_KEY is NOT in process.env
  const originalKey = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;

  try {
    // Mock a simple LLM call with the env: prefix
    // This should now fallback to read from ~/.openclaw/.env
    const testConfig = {
      endpoint: 'https://api.anthropic.com/v1/messages',
      model: 'claude-haiku-4-5',
      prompt: 'Hello',
      temperature: 0.6,
      maxTokens: 10,
      timeoutMs: 10000,
      apiKey: 'env:ANTHROPIC_API_KEY',
      format: 'anthropic'
    };

    // We'll make a real call to verify the key resolution works
    // (with low maxTokens to minimize cost)
    console.log('Making test call to Anthropic API...');
    const result = await callLLM(testConfig);

    console.log('\n✅ SUCCESS: API key resolved correctly from ~/.openclaw/.env');
    console.log('Response sample:', result.slice(0, 100) + (result.length > 100 ? '...' : ''));
    console.log('\nThe fix is working! ANTHROPIC_API_KEY was read from ~/.openclaw/.env');

  } catch (err) {
    console.error('\n❌ FAILED:', err.message);
    if (err.message.includes('401') || err.message.includes('authentication')) {
      console.error('\nAPI key was not resolved correctly from ~/.openclaw/.env');
    }
    process.exit(1);
  } finally {
    // Restore original key if it existed
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
  }
}

test();

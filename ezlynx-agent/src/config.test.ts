import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError, describeConfig } from './config.js';

const BASE: NodeJS.ProcessEnv = {
  CAMOFOX_URL: 'http://localhost:9377',
  CAMOFOX_USER_ID: 'ezlynx-agent',
  CAMOFOX_CRASH_REPORT_ENABLED: 'false',
  DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  DEEPSEEK_MODEL: 'deepseek-flash',
  EZLYNX_BASE_URL: 'https://app.ezlynx.com',
};

function problemsOf(env: NodeJS.ProcessEnv, options?: Parameters<typeof loadConfig>[1]): string[] {
  try {
    loadConfig(env, options);
    return [];
  } catch (err) {
    assert.ok(err instanceof ConfigError);
    return err.problems;
  }
}

describe('crash-reporter gate', () => {
  test('refuses to start when telemetry is not explicitly disabled', () => {
    const { CAMOFOX_CRASH_REPORT_ENABLED: _omitted, ...env } = BASE;
    const problems = problemsOf(env);
    assert.ok(problems.some((p) => p.includes('CAMOFOX_CRASH_REPORT_ENABLED')));
  });

  test('"true" is rejected just as firmly as unset', () => {
    const problems = problemsOf({ ...BASE, CAMOFOX_CRASH_REPORT_ENABLED: 'true' });
    assert.ok(problems.some((p) => p.includes('CAMOFOX_CRASH_REPORT_ENABLED')));
  });

  test('accepts an explicit false', () => {
    assert.doesNotThrow(() => loadConfig(BASE));
  });
});

describe('defaults and coercion', () => {
  test('sensible defaults are applied', () => {
    const config = loadConfig(BASE);
    assert.equal(config.camofoxSessionKey, 'default');
    assert.equal(config.requireSubmitConfirmation, true);
    assert.equal(config.debugArtifacts, false);
    assert.equal(config.httpTimeoutMs, 30_000);
    assert.equal(config.deepseekModel, 'deepseek-flash');
  });

  test('submit confirmation only disables on an explicit falsey value', () => {
    assert.equal(loadConfig({ ...BASE, REQUIRE_SUBMIT_CONFIRMATION: 'false' }).requireSubmitConfirmation, false);
    assert.equal(loadConfig({ ...BASE, REQUIRE_SUBMIT_CONFIRMATION: '' }).requireSubmitConfirmation, true);
    assert.equal(loadConfig({ ...BASE, REQUIRE_SUBMIT_CONFIRMATION: 'yes' }).requireSubmitConfirmation, true);
  });

  test('a malformed camofox URL is rejected', () => {
    const problems = problemsOf({ ...BASE, CAMOFOX_URL: 'not-a-url' });
    assert.ok(problems.some((p) => p.includes('camofoxUrl')));
  });
});

describe('DeepSeek key handling', () => {
  test('key is optional unless the command needs the LLM', () => {
    assert.doesNotThrow(() => loadConfig(BASE));
    const problems = problemsOf(BASE, { requireLlm: true });
    assert.ok(problems.some((p) => p.includes('DEEPSEEK_API_KEY')));
  });

  test('the DEEP_SEEK_API_KEY misspelling is caught rather than silently ignored', () => {
    const problems = problemsOf({ ...BASE, DEEP_SEEK_API_KEY: 'sk-whatever' });
    assert.ok(problems.some((p) => p.includes('DEEP_SEEK_API_KEY')));
  });
});

describe('describeConfig', () => {
  test('never exposes key material', () => {
    const config = loadConfig({ ...BASE, DEEPSEEK_API_KEY: 'sk-secret-value', CAMOFOX_ACCESS_KEY: 'access-secret' });
    const described = JSON.stringify(describeConfig(config));
    assert.ok(!described.includes('sk-secret-value'));
    assert.ok(!described.includes('access-secret'));
    assert.match(described, /"deepseekAuth":"configured"/);
    assert.match(described, /"camofoxAuth":"access-key"/);
  });
});

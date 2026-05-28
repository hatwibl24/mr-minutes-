// ============================================================
// MR. MINUTES — vision.js
//
// Purpose:
// - provide hybrid visual perception for desktop automation
// - run fast local checks first through Hands.js
// - escalate to Gemini Vision for broader semantic understanding
// - return structured JSON the rest of the system can use
//
// Env:
// - GEMINI_VISION_API_KEY=your_api_key
// - GEMINI_VISION_MODEL=gemini-2.5-flash   (optional)
//
// Contract:
// - every exported function returns a structured object
// - local helpers preserve Hands.js-like { ok, error } style
// ============================================================

'use strict';

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });

let hands = null;
try {
  hands = require('./Hands');
} catch (err) {
  console.warn('[vision] Hands not available:', err.message);
}

const MODEL_NAME =
  process.env.GEMINI_VISION_MODEL ||
  process.env.GEMINIVISIONMODEL ||
  'gemini-2.5-flash';

const API_KEY =
  process.env.GEMINI_VISION_API_KEY ||
  process.env.GEMINIVISIONAPIKEY ||
  process.env.GEMINIAPIKEY ||
  '';

const GEMINI_URL =
  `https://generativelanguage.googleapis.com/v1beta/models/${MODEL_NAME}:generateContent`;

const DEFAULTS = {
  temperature: 0.2,
  maxOutputTokens: 1200,
  localFirst: true,
  modelForBroadView: true,
  modelOnLocalFailure: true,
  localConfidenceThreshold: 0.5,
  screenshotPath: null,
  localTargets: [],
  region: null,
  appHint: null,
  phaseHint: null,
  goal: 'Understand what is visible on the current screen for a desktop automation agent.',
};

function nowIso() {
  return new Date().toISOString();
}

function makeOk(data = {}) {
  return { ok: true, ...data };
}

function makeErr(error, extras = {}) {
  return { ok: false, error: String(error || 'unknown error'), ...extras };
}

function safeArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function clampConfidence(n, fallback = 0.3) {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  if (v < 0) return 0;
  if (v > 1) return 1;
  return v;
}

function sanitizeText(text) {
  return String(text || '')
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();
}

function inferMimeType(filePath) {
  const ext = path.extname(String(filePath || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.webp') return 'image/webp';
  return 'image/png';
}

function readImageAsBase64(filePath) {
  const abs = path.resolve(filePath);
  const data = fs.readFileSync(abs);
  return data.toString('base64');
}

function normalizeObservationShape(input = {}) {
  return {
    app: input.app || null,
    screenType: input.screenType || null,
    summary: input.summary || 'No summary available.',
    pageReady: typeof input.pageReady === 'boolean' ? input.pageReady : null,
    loading: typeof input.loading === 'boolean' ? input.loading : null,
    modalOpen: typeof input.modalOpen === 'boolean' ? input.modalOpen : null,
    primaryAction: input.primaryAction || null,
    visibleInputs: safeArray(input.visibleInputs),
    visibleButtons: safeArray(input.visibleButtons),
    visibleText: safeArray(input.visibleText),
    warnings: safeArray(input.warnings),
    errors: safeArray(input.errors),
    blockers: safeArray(input.blockers),
    nextBestAction: input.nextBestAction || null,
    confidence: clampConfidence(input.confidence, 0.3),
  };
}

function isVisionConfigured() {
  return !!API_KEY;
}

async function ensureScreenshot(preferredPath = null) {
  try {
    if (preferredPath) {
      const abs = path.resolve(preferredPath);
      if (fs.existsSync(abs)) {
        return makeOk({ path: abs, existing: true });
      }
    }

    if (!hands || typeof hands.takeSystemScreenshot !== 'function') {
      return makeErr('Hands.takeSystemScreenshot is unavailable');
    }

    const shot = await hands.takeSystemScreenshot(preferredPath || null);

    if (!shot?.ok) {
      return makeErr(shot?.error || 'failed to take screenshot');
    }

    if (!shot.path) {
      return makeErr('screenshot path missing from Hands.takeSystemScreenshot');
    }

    return makeOk({
      path: path.resolve(shot.path),
      existing: false,
    });
  } catch (err) {
    return makeErr(err.message);
  }
}

async function runLocalVision(options = {}) {
  const startedAt = nowIso();
  const screenshot = await ensureScreenshot(options.screenshotPath || null);

  if (!screenshot.ok) {
    return makeErr(screenshot.error, {
      source: 'local',
      at: startedAt,
    });
  }

  const checks = [];
  const matchedText = [];
  const visibleSignals = [];
  const warnings = [];
  const localTargets = safeArray(options.localTargets).slice(0, 10);

  if (!localTargets.length) {
    warnings.push('No localTargets were provided, so local analysis is shallow.');
  }

  if (!hands || typeof hands.findText !== 'function') {
    warnings.push('Hands.findText is unavailable, skipping OCR-style local checks.');
  } else {
    for (const target of localTargets) {
      try {
        const found = await hands.findText(target, options.region || null);
        const hit = !!(
          found?.ok &&
          (
            found.text ||
            found.match ||
            found.matches?.length ||
            (typeof found.x === 'number' && typeof found.y === 'number')
          )
        );

        checks.push({
          kind: 'findText',
          target,
          ok: !!found?.ok,
          found: hit,
          x: found?.x ?? null,
          y: found?.y ?? null,
          raw: found || null,
        });

        if (hit) {
          matchedText.push(target);
          visibleSignals.push(`text:${target}`);
        }
      } catch (err) {
        checks.push({
          kind: 'findText',
          target,
          ok: false,
          found: false,
          error: err.message,
        });
      }
    }
  }

  let confidence = 0.28;
  let summary = 'Local checks were inconclusive.';

  if (matchedText.length > 0) {
    confidence = Math.min(0.85, 0.45 + matchedText.length * 0.08);
    summary = `Matched local targets: ${matchedText.join(', ')}`;
  }

  return makeOk({
    source: 'local',
    at: startedAt,
    screenshotPath: screenshot.path,
    appGuess: options.appHint || null,
    summary,
    matchedText,
    visibleSignals,
    confidence,
    checks,
    warnings,
    failed: false,
  });
}

function buildSchemaInstruction() {
  return [
    'Return ONLY valid JSON.',
    'Do not wrap the response in markdown fences.',
    'Use this exact shape:',
    JSON.stringify({
      app: 'string|null',
      screenType: 'string|null',
      summary: 'string',
      pageReady: true,
      loading: false,
      modalOpen: false,
      primaryAction: 'string|null',
      visibleInputs: ['string'],
      visibleButtons: ['string'],
      visibleText: ['string'],
      warnings: ['string'],
      errors: ['string'],
      blockers: ['string'],
      nextBestAction: 'string|null',
      confidence: 0.0,
    }),
  ].join('\n');
}

function buildVisionPrompt(options = {}, localResult = null) {
  const goal = options.goal || DEFAULTS.goal;
  const appHint = options.appHint || 'unknown';
  const phaseHint = options.phaseHint || 'unknown';

  const localContext = localResult?.ok
    ? JSON.stringify(
        {
          summary: localResult.summary,
          matchedText: localResult.matchedText,
          visibleSignals: localResult.visibleSignals,
          confidence: localResult.confidence,
          warnings: localResult.warnings,
        },
        null,
        2
      )
    : 'null';

  return [
    'You are the visual perception layer for Mr. Minutes, a desktop AI assistant.',
    'Analyze the screenshot and describe only what is visibly on screen.',
    'Do not invent hidden state. If uncertain, say so with lower confidence.',
    `Goal context: ${goal}`,
    `App hint: ${appHint}`,
    `Phase hint: ${phaseHint}`,
    'Local analysis from tools:',
    localContext,
    'Instructions:',
    '- Identify the likely app or website if visible.',
    '- Identify whether the page seems ready, loading, blocked, or in error.',
    '- List visible inputs, buttons, warnings, and blockers only if actually visible.',
    '- Suggest the next best action for a desktop automation agent.',
    '- Keep the summary operationally useful for recovery and user narration.',
    buildSchemaInstruction(),
  ].join('\n\n');
}

async function callGeminiVision({ screenshotPath, prompt, temperature, maxOutputTokens }) {
  if (!API_KEY) {
    return makeErr('Missing GEMINI_VISION_API_KEY in .env');
  }

  try {
    const inlineData = {
      mimeType: inferMimeType(screenshotPath),
      data: readImageAsBase64(screenshotPath),
    };

    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              { inlineData },
            ],
          },
        ],
        generationConfig: {
          temperature: Number.isFinite(temperature) ? temperature : DEFAULTS.temperature,
          maxOutputTokens: Number.isFinite(maxOutputTokens)
            ? maxOutputTokens
            : DEFAULTS.maxOutputTokens,
          responseMimeType: 'application/json',
        },
      }),
    });

    const rawText = await res.text();

    if (!res.ok) {
      return makeErr(`Gemini vision error ${res.status}: ${rawText.slice(0, 800)}`);
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      return makeErr(`Gemini returned non-JSON HTTP body: ${err.message}`, {
        rawHttpBody: rawText,
      });
    }

    const rawModelText = sanitizeText(
      data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
    );

    if (!rawModelText) {
      return makeErr('Gemini returned an empty vision response', {
        rawHttpBody: rawText,
      });
    }

    let parsed;
    try {
      parsed = JSON.parse(rawModelText);
    } catch (err) {
      return makeErr(`Gemini returned invalid JSON content: ${err.message}`, {
        rawModelResponse: rawModelText,
      });
    }

    return makeOk({
      source: 'model',
      at: nowIso(),
      modelName: MODEL_NAME,
      screenshotPath: path.resolve(screenshotPath),
      rawModelResponse: rawModelText,
      parsed: normalizeObservationShape(parsed),
      usage: data?.usageMetadata || null,
    });
  } catch (err) {
    return makeErr(err.message);
  }
}

function mergeVision(localResult, modelResult) {
  const local = localResult?.ok ? localResult : null;
  const model = modelResult?.ok ? modelResult : null;
  const parsed = normalizeObservationShape(model?.parsed || {});

  return makeOk({
    source: local && model ? 'hybrid' : model ? 'model' : 'local',
    at: nowIso(),
    screenshotPath: local?.screenshotPath || model?.screenshotPath || null,

    app: parsed.app || local?.appGuess || null,
    screenType: parsed.screenType || null,
    summary: parsed.summary || local?.summary || 'No summary available.',
    pageReady: parsed.pageReady,
    loading: parsed.loading,
    modalOpen: parsed.modalOpen,
    primaryAction: parsed.primaryAction,
    visibleInputs: parsed.visibleInputs,
    visibleButtons: parsed.visibleButtons,
    visibleText: parsed.visibleText,
    warnings: [...new Set([...(local?.warnings || []), ...parsed.warnings])],
    errors: parsed.errors,
    blockers: parsed.blockers,
    nextBestAction: parsed.nextBestAction,
    confidence:
      typeof parsed.confidence === 'number'
        ? clampConfidence(parsed.confidence, 0.3)
        : clampConfidence(local?.confidence, 0.3),

    local,
    model,
  });
}

function shouldEscalateToModel(options, localResult) {
  if (!options.localFirst) return true;
  if (!localResult?.ok) return true;
  if (options.modelForBroadView) return true;

  if (
    options.modelOnLocalFailure &&
    (localResult.confidence ?? 0) < (options.localConfidenceThreshold ?? 0.5)
  ) {
    return true;
  }

  return false;
}

async function describeScreen(opts = {}) {
  const options = { ...DEFAULTS, ...opts };

  let localResult = null;
  if (options.localFirst) {
    localResult = await runLocalVision(options);
  }

  const escalate = shouldEscalateToModel(options, localResult);
  if (!escalate) {
    return mergeVision(localResult, null);
  }

  let ensured;
  if (localResult?.ok && localResult.screenshotPath) {
    ensured = makeOk({ path: localResult.screenshotPath, existing: true });
  } else {
    ensured = await ensureScreenshot(options.screenshotPath || null);
  }

  if (!ensured.ok) {
    return makeErr(ensured.error, {
      local: localResult || null,
    });
  }

  const prompt = buildVisionPrompt(options, localResult?.ok ? localResult : null);
  const modelResult = await callGeminiVision({
    screenshotPath: ensured.path,
    prompt,
    temperature: options.temperature,
    maxOutputTokens: options.maxOutputTokens,
  });

  if (!modelResult.ok && localResult?.ok) {
    return makeOk({
      source: 'local-fallback',
      at: nowIso(),
      screenshotPath: localResult.screenshotPath,
      app: localResult.appGuess || null,
      screenType: null,
      summary: localResult.summary,
      pageReady: null,
      loading: null,
      modalOpen: null,
      primaryAction: null,
      visibleInputs: [],
      visibleButtons: [],
      visibleText: [],
      warnings: [
        ...(localResult.warnings || []),
        `Model fallback failed: ${modelResult.error}`,
      ],
      errors: [],
      blockers: [],
      nextBestAction: null,
      confidence: clampConfidence(localResult.confidence, 0.3),
      local: localResult,
      model: modelResult,
    });
  }

  if (!modelResult.ok) {
    return modelResult;
  }

  return mergeVision(localResult, modelResult);
}

async function describeChange(opts = {}) {
  const options = { ...DEFAULTS, ...opts };
  const beforePath = options.beforePath ? path.resolve(options.beforePath) : null;

  if (!beforePath) {
    return makeErr('describeChange requires beforePath');
  }

  const afterShot = options.afterPath
    ? makeOk({ path: path.resolve(options.afterPath) })
    : await ensureScreenshot(options.screenshotPath || null);

  if (!afterShot.ok) {
    return makeErr(afterShot.error);
  }

  if (!API_KEY) {
    return makeErr('Missing GEMINI_VISION_API_KEY in .env');
  }

  const prompt = [
    'You are the visual perception layer for Mr. Minutes.',
    'Compare the two screenshots and explain the visible change.',
    `Goal context: ${options.goal || 'Detect what changed on screen.'}`,
    'Return ONLY valid JSON.',
    'Do not wrap the response in markdown fences.',
    'Use this exact shape: {"summary":"string","changed":true,"likelyCause":"string|null","blockers":["string"],"nextBestAction":"string|null","confidence":0.0}',
  ].join('\n\n');

  try {
    const res = await fetch(GEMINI_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,
      },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [
              { text: prompt },
              {
                inlineData: {
                  mimeType: inferMimeType(beforePath),
                  data: readImageAsBase64(beforePath),
                },
              },
              {
                inlineData: {
                  mimeType: inferMimeType(afterShot.path),
                  data: readImageAsBase64(afterShot.path),
                },
              },
            ],
          },
        ],
        generationConfig: {
          temperature: 0.2,
          maxOutputTokens: 1000,
          responseMimeType: 'application/json',
        },
      }),
    });

    const rawText = await res.text();

    if (!res.ok) {
      return makeErr(`Gemini vision diff error ${res.status}: ${rawText.slice(0, 800)}`);
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (err) {
      return makeErr(`Gemini returned non-JSON diff HTTP body: ${err.message}`, {
        rawHttpBody: rawText,
      });
    }

    const rawModelResponse = sanitizeText(
      data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || ''
    );

    if (!rawModelResponse) {
      return makeErr('Gemini returned an empty compare response');
    }

    let parsed;
    try {
      parsed = JSON.parse(rawModelResponse);
    } catch (err) {
      return makeErr(`Gemini returned invalid compare JSON: ${err.message}`, {
        rawModelResponse,
      });
    }

    return makeOk({
      source: 'model-diff',
      at: nowIso(),
      beforePath,
      afterPath: afterShot.path,
      modelName: MODEL_NAME,
      rawModelResponse,
      parsed: {
        summary: parsed.summary || 'No visible change summary returned.',
        changed: typeof parsed.changed === 'boolean' ? parsed.changed : null,
        likelyCause: parsed.likelyCause || null,
        blockers: safeArray(parsed.blockers),
        nextBestAction: parsed.nextBestAction || null,
        confidence: clampConfidence(parsed.confidence, 0.3),
      },
      usage: data?.usageMetadata || null,
    });
  } catch (err) {
    return makeErr(err.message);
  }
}

module.exports = {
  describeScreen,
  describeChange,
  runLocalVision,
  ensureScreenshot,
  buildVisionPrompt,
  callGeminiVision,
  isVisionConfigured,
};
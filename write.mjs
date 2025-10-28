import { generateText, createGoogle } from 'ai';
import fs from 'fs';

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY;
if (!GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY) is required');
  process.exit(1);
}

const google = createGoogle({ apiKey: GEMINI_API_KEY });
const MODEL_NAME = process.env.WRITE_MODEL || 'gemini-2.5-flash-lite';

// 応答として期待する JSON 構造のスキーマを定義します
const POST_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    draftBody: { type: 'string' },
    tags: {
      type: 'array',
      items: { type: 'string' }
    }
  },
  required: ['title', 'draftBody', 'tags']
};

function readResearchMarkdown() {
  try {
    return fs.readFileSync('.note-artifacts/research.md', 'utf8');
  } catch (error) {
    console.error('Failed to read research markdown at .note-artifacts/research.md');
    throw error;
  }
}

function extractJsonFlexible(raw) {
  const text = (raw || '').trim().replace(/\u200B/g, '');
  try {
    return JSON.parse(text);
  } catch (_) {
    // try fenced code block
    const fence = text.match(/```[a-zA-Z]*\s*([\s\S]*?)\s*```/);
    if (fence && fence[1]) {
      try {
        return JSON.parse(fence[1].trim());
      } catch (_) {
        // ignore
      }
    }
    // try object slice
    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const candidate = text.slice(firstBrace, lastBrace + 1);
      try {
        return JSON.parse(candidate);
      } catch (_) {
        // ignore
      }
    }
  }
  return null;
}

async function repairJson(raw) {
  const system = '入力から {"title":string,"draftBody":string,"tags":string[]} のJSONのみ返答。';
  const result = await generateText({
    model: google(MODEL_NAME),
    system,
    prompt: String(raw),
    temperature: 0,
    responseSchema: POST_SCHEMA,
    maxTokens: 2048,
    maxOutputTokens: 2048
  });

  try {
    return JSON.parse(result.text);
  } catch (_) {
    return extractJsonFlexible(result.text || '');
  }
}

function sanitizeTitle(value) {
  let title = String(value || '').trim();
  title = title.replace(/^```[a-zA-Z0-9_-]*\s*$/, '').replace(/^```$/, '');
  title = title.replace(/^#+\s*/, '');
  title = title.replace(/^"+|"+$/g, '').replace(/^'+|'+$/g, '');
  title = title.replace(/^`+|`+$/g, '');
  title = title.replace(/^json$/i, '').trim();
  if (!title) {
    title = 'タイトル（自動生成）';
  }
  return title;
}

function deriveTitleFromText(text) {
  const lines = (text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstRealLine = lines.find((line) => !/^```/.test(line)) || lines[0] || '';
  return sanitizeTitle(firstRealLine);
}

async function main() {
  const theme = process.env.THEME || '';
  const target = process.env.TARGET || '';
  const message = process.env.MESSAGE || '';
  const cta = process.env.CTA || '';
  const inputTags = (process.env.INPUT_TAGS || '')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);

  const researchReport = readResearchMarkdown();

  const systemPrompt = 'note.com向け長文記事の生成。JSON {title,draftBody,tags[]} で返答。draftBodyは6000〜9000文字を目安に十分な分量で、章ごとに小見出しと箇条書きを適切に含めること。';
  const prompt = [`{テーマ}: ${theme}`, `{ペルソナ}: ${target}`, `{リサーチ内容}: ${researchReport}`, `{伝えたいこと}: ${message}`, `{読後のアクション}: ${cta}`].join('\n');

  const { text } = await generateText({
    model: google(MODEL_NAME),
    system: systemPrompt,
    prompt,
    temperature: 0.7,
    responseSchema: POST_SCHEMA,
    maxOutputTokens: 8192
  });

  let parsed = extractJsonFlexible(text || '') || (await repairJson(text || ''));

  let title;
  let draftBody;
  let tags;

  if (parsed) {
    title = sanitizeTitle(parsed.title);
    draftBody = String(parsed.draftBody || '').trim();
    tags = Array.isArray(parsed.tags) ? parsed.tags.map(String) : [];
  }

  if (!title || !draftBody) {
    title = deriveTitleFromText(text || '');
    const lines = (text || '').split(/\r?\n/);
    draftBody = lines.slice(1).join('\n').trim() || (text || '');
    tags = [];
  }

  if (inputTags.length) {
    const merged = new Set([...(tags || []), ...inputTags]);
    tags = Array.from(merged);
  }

  fs.mkdirSync('.note-artifacts', { recursive: true });
  fs.writeFileSync('.note-artifacts/draft.json', JSON.stringify({ title, draftBody, tags }, null, 2));
}

main().catch((error) => {
  console.error('Failed to generate draft:', error);
  process.exitCode = 1;
});

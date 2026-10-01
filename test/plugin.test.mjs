// The Claude Code plugin and Agent Skill in plugins/hush: the manifests parse
// and agree, the skill's frontmatter stays inside the Agent Skills spec (other
// agents and claude.ai refuse anything else), the skill says which SDK it
// describes, and every relative link and plugin path resolves. No database,
// no network.
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = join(root, 'plugins', 'hush');
const skillDir = join(pluginDir, 'skills', 'hush');
const referencesDir = join(skillDir, 'references');
const agentsDir = join(pluginDir, 'agents');
const commandsDir = join(pluginDir, 'commands');

const read = (file) => readFileSync(file, 'utf8');
const json = (file) => JSON.parse(read(file));
const mdIn = (dir) => readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => join(dir, f));
const rel = (file) => file.slice(root.length + 1);

const references = mdIn(referencesDir);
const agents = mdIn(agentsDir);
const commands = mdIn(commandsDir);

/**
 * The frontmatter these files use: `key: value`, quoted or plain, and one
 * level of `key:` followed by indented `sub: value` lines. A plain value may
 * not hold ": " or " #", which YAML would read as a mapping or a comment.
 */
function frontmatter(file) {
  const text = read(file);
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, `${rel(file)}: no frontmatter at the top`);
  const data = {};
  let map = null;
  for (const line of m[1].split('\n')) {
    if (!line.trim()) continue;
    const nested = /^\s+([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (nested) {
      assert.ok(map, `${rel(file)}: indented line outside a map: "${line}"`);
      map[nested[1]] = scalar(file, nested[2]);
      continue;
    }
    const top = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    assert.ok(top, `${rel(file)}: unreadable frontmatter line: "${line}"`);
    if (top[2] === '') map = data[top[1]] = {};
    else {
      map = null;
      data[top[1]] = scalar(file, top[2]);
    }
  }
  return { data, body: text.slice(m[0].length) };
}

function scalar(file, raw) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw) || /^'(?:[^']|'')*'$/.test(raw)) return raw.slice(1, -1);
  assert.ok(!/: |\s#/.test(raw), `${rel(file)}: quote this value, YAML would misread it: ${raw.slice(0, 60)}…`);
  assert.ok(!/^[[{&*!|>%@`]/.test(raw), `${rel(file)}: quote this value, it starts with a YAML indicator: ${raw.slice(0, 60)}`);
  return raw;
}

// Markdown outside fenced code blocks and inline code: what links and headings live in.
const prose = (text) => text.replace(/^```[\s\S]*?^```/gm, '').replace(/`[^`\n]*`/g, '');

/** GitHub's heading anchors, with -1, -2 for repeats. */
function anchors(file) {
  const seen = new Map();
  const out = new Set();
  for (const m of prose(read(file)).matchAll(/^#{1,6}\s+(.+?)\s*#*\s*$/gm)) {
    const base = m[1].toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/\s/g, '-');
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n ? `${base}-${n}` : base);
  }
  return out;
}

/** Relative links in a markdown file that do not resolve, as "target: reason". */
function brokenLinks(file) {
  const broken = [];
  for (const m of prose(read(file)).matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('${')) continue;
    const [path, anchor] = target.split('#');
    const dest = path ? resolve(dirname(file), decodeURIComponent(path)) : file;
    if (!existsSync(dest)) {
      broken.push(`${target}: no such file`);
      continue;
    }
    if (anchor && dest.endsWith('.md') && !anchors(dest).has(anchor)) broken.push(`${target}: no such heading`);
  }
  return broken;
}

const marketplace = json(join(root, '.claude-plugin', 'marketplace.json'));
const manifest = json(join(pluginDir, '.claude-plugin', 'plugin.json'));
let parsedSkill;
const skill = () => (parsedSkill ??= frontmatter(join(skillDir, 'SKILL.md')));

test('the marketplace lists one plugin, hush, at ./plugins/hush', () => {
  assert.equal(marketplace.name, 'hush');
  assert.ok(marketplace.owner?.name, 'marketplace owner.name is required');
  assert.ok(marketplace.description, 'marketplace description');
  assert.equal(marketplace.plugins.length, 1);
  const [entry] = marketplace.plugins;
  assert.equal(entry.name, 'hush');
  assert.equal(entry.source, './plugins/hush');
  assert.ok(existsSync(resolve(root, entry.source, '.claude-plugin', 'plugin.json')), 'the source holds a plugin manifest');
  assert.equal(entry.version, undefined, 'the version lives in plugin.json only');
});

test("the plugin manifest's name matches the marketplace entry, with a version and no component paths", () => {
  assert.equal(manifest.name, marketplace.plugins[0].name);
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
  for (const field of ['description', 'author', 'homepage', 'repository', 'license']) assert.ok(manifest[field], `plugin.json ${field}`);
  for (const field of ['skills', 'agents', 'commands', 'hooks', 'mcpServers', 'lspServers', 'outputStyles']) {
    assert.equal(manifest[field], undefined, `plugin.json declares ${field}; the default folders already load`);
  }
});

test('the skill is named after its directory, within the spec limits', () => {
  const { name, description, compatibility } = skill().data;
  assert.equal(name, basename(skillDir));
  assert.match(name, /^[a-z0-9]+(-[a-z0-9]+)*$/);
  assert.ok(name.length <= 64);
  assert.ok(!/anthropic|claude/.test(name));
  assert.equal(typeof description, 'string');
  assert.ok(description.length > 0 && description.length <= 1024, `description is ${description.length} characters; the limit is 1024`);
  assert.ok(!/^(I|You|Use)\b/.test(description), 'the description is in the third person, the main use first');
  if (compatibility !== undefined) assert.ok(compatibility.length <= 500, 'compatibility is at most 500 characters');
});

test('SKILL.md frontmatter has only Agent Skills spec fields', () => {
  const allowed = ['name', 'description', 'license', 'compatibility', 'metadata', 'allowed-tools'];
  for (const key of Object.keys(skill().data)) assert.ok(allowed.includes(key), `SKILL.md frontmatter field "${key}" is not in the spec`);
  assert.equal(typeof skill().data.metadata, 'object');
  for (const [k, v] of Object.entries(skill().data.metadata)) assert.equal(typeof v, 'string', `metadata.${k} is a string`);
});

test('the skill names the SDK version in sdk/package.json', () => {
  const sdk = json(join(root, 'sdk', 'package.json'));
  assert.equal(skill().data.metadata.sdk, sdk.name);
  assert.equal(skill().data.metadata['sdk-version'], sdk.version, 'update metadata.sdk-version in SKILL.md, and the references, when the SDK changes');
});

test('SKILL.md stays short, links every reference, and uses plain relative links', () => {
  const lines = read(join(skillDir, 'SKILL.md')).split('\n').length;
  assert.ok(lines < 500, `SKILL.md has ${lines} lines; move detail into references/`);
  for (const file of [join(skillDir, 'SKILL.md'), ...references]) {
    assert.ok(!read(file).includes('${CLAUDE_PLUGIN_ROOT}'), `${rel(file)}: only Claude Code substitutes \${CLAUDE_PLUGIN_ROOT}; use a relative link`);
  }
  const linked = new Set([...prose(skill().body).matchAll(/\]\((references\/[^)#\s]+)/g)].map((m) => m[1]));
  for (const file of references) assert.ok(linked.has(`references/${basename(file)}`), `SKILL.md does not link references/${basename(file)}`);
});

test('references over 100 lines open with a table of contents', () => {
  for (const file of references) {
    const lines = read(file).split('\n');
    if (lines.length <= 100) continue;
    assert.ok(lines.slice(0, 20).some((l) => /^##\s+Contents\b/.test(l)), `${rel(file)} has ${lines.length} lines and no Contents near the top`);
  }
});

test('the web module in SKILL.md and in install.md starts hush and claims the entry the same way', () => {
  const startup = (file) => {
    const block = [...read(file).matchAll(/^```ts\n([\s\S]*?)^```/gm)].map((m) => m[1]).find((code) => code.includes('createWebHush('));
    assert.ok(block, `${rel(file)}: no web module`);
    const ready = /export const hushReady = [\s\S]*?;\n/.exec(block);
    assert.ok(ready, `${rel(file)}: the web module exports no hushReady`);
    const entry = /^if \(browser [^\n]*hush\.entry\('link'[^\n]*\n/m.exec(block);
    assert.ok(entry, `${rel(file)}: the web module claims no link entry`);
    return { ready: ready[0].replace(/\s+/g, ' '), entry: entry[0].trim() };
  };
  const inSkill = startup(join(skillDir, 'SKILL.md'));
  assert.deepEqual(inSkill, startup(join(referencesDir, 'install.md')));
  assert.match(inSkill.ready, /browser \?/, 'init() runs in the browser only');
});

test('each agent has a name, matching its file, and a description', () => {
  assert.ok(agents.length > 0);
  const colors = ['red', 'blue', 'green', 'yellow', 'purple', 'orange', 'pink', 'cyan'];
  for (const file of agents) {
    const { data } = frontmatter(file);
    assert.ok(data.name, `${rel(file)}: name`);
    assert.ok(!data.name.includes(':'), `${rel(file)}: a name cannot contain ":"`);
    assert.equal(data.name, basename(file, '.md'));
    assert.ok(data.description && data.description.length > 40, `${rel(file)}: a description that says when to delegate`);
    if (data.color !== undefined) assert.ok(colors.includes(data.color), `${rel(file)}: color ${data.color}`);
  }
});

test('each command has a description', () => {
  for (const file of commands) assert.ok(frontmatter(file).data.description, `${rel(file)}: description`);
});

test('every relative link in the skill, its references, the agents and the commands resolves', () => {
  for (const file of [join(skillDir, 'SKILL.md'), ...references, ...agents, ...commands, join(root, 'AGENTS.md')]) {
    assert.deepEqual(brokenLinks(file), [], `${rel(file)} has broken links`);
  }
});

test('every ${CLAUDE_PLUGIN_ROOT} path in the agents and commands exists in the plugin', () => {
  for (const file of [...agents, ...commands]) {
    for (const m of read(file).matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`'")]+)/g)) {
      const path = m[1].replace(/[.,;:]+$/, '');
      assert.ok(existsSync(join(pluginDir, path)), `${rel(file)}: \${CLAUDE_PLUGIN_ROOT}/${path} does not exist`);
    }
  }
});

test('nothing outside the plugin is needed by it', () => {
  // Only plugins/hush is copied into a user's plugin cache.
  const walk = (dir) => readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? walk(join(dir, f)) : [join(dir, f)]));
  for (const file of walk(pluginDir).filter((f) => f.endsWith('.md'))) {
    for (const m of prose(read(file)).matchAll(/\]\((\.\.\/[^)#\s]*)/g)) {
      assert.ok(resolve(dirname(file), m[1]).startsWith(pluginDir + '/'), `${rel(file)} links outside the plugin: ${m[1]}`);
    }
  }
});

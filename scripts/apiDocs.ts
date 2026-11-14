// CasiWorks Pro - API reference generator
//
// Reads the public API's TypeScript declarations (src/api) and their doc
// comments with the TypeScript compiler, adds the live command list, and
// renders one self-contained HTML page. `npm run docs:api` writes it to
// public/api/index.html, which the app serves at /api/.
import ts from 'typescript';
import { createCommandRegistry } from '../src/commands/builtinCommands.ts';
import { attachMacros } from '../src/commands/macros.ts';
import { useCADStore } from '../src/store/cadStore.ts';
import { API_VERSION } from '../src/api/CasiWorksAPI.ts';
import type { CommandInfo } from '../src/commands/CommandRegistry.ts';

export const API_ENTRY = 'src/api/index.ts';

export interface DocTag { name: string; text: string }
export interface DocMember { name: string; signature: string; doc: string; tags: DocTag[] }
export interface DocType {
  name: string;
  kind: 'interface' | 'type' | 'class' | 'const' | 'function';
  doc: string;
  tags: DocTag[];
  /** Declaration text for type aliases, constants and functions. */
  text?: string;
  members: DocMember[];
  file: string;
}

export interface ApiModel {
  version: string;
  types: DocType[];
  commands: CommandInfo[];
}

const docOf = (checker: ts.TypeChecker, symbol: ts.Symbol | undefined) =>
  symbol ? ts.displayPartsToString(symbol.getDocumentationComment(checker)).trim() : '';
const tagsOf = (symbol: ts.Symbol | undefined, checker: ts.TypeChecker): DocTag[] =>
  symbol ? symbol.getJsDocTags(checker).map(t => ({ name: t.name, text: ts.displayPartsToString(t.text).trim() })) : [];
const compact = (text: string) => text.replace(/\s+/g, ' ').replace(/;$/, '').trim();

/** Everything exported from the API entry point, with docs, from the sources. */
export function readApiModel(entry = API_ENTRY): ApiModel {
  const program = ts.createProgram([entry], {
    allowImportingTsExtensions: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, skipLibCheck: true,
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entry);
  if (!source) throw new Error(`Cannot read ${entry}`);
  const moduleSymbol = checker.getSymbolAtLocation(source)!;

  const types: DocType[] = [];
  for (const exported of checker.getExportsOfModule(moduleSymbol)) {
    const symbol = exported.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(exported) : exported;
    const decl = symbol.declarations?.[0];
    if (!decl) continue;
    const file = decl.getSourceFile().fileName.replace(/^.*?(src\/)/, '$1');
    const base = { name: exported.name, doc: docOf(checker, symbol), tags: tagsOf(symbol, checker), file };

    if (ts.isInterfaceDeclaration(decl) || ts.isClassDeclaration(decl)) {
      const members: DocMember[] = [];
      for (const m of decl.members) {
        const ms = m.name ? checker.getSymbolAtLocation(m.name) : undefined;
        if (!ms || (ts.isClassDeclaration(decl) && !ts.isPropertyDeclaration(m) && !ts.isMethodDeclaration(m))) continue;
        if (ts.getCombinedModifierFlags(m as ts.Declaration) & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) continue;
        // Signature as written (getText skips the leading doc comment)
        members.push({ name: ms.name, signature: compact(m.getText()), doc: docOf(checker, ms), tags: tagsOf(ms, checker) });
      }
      types.push({ ...base, kind: ts.isInterfaceDeclaration(decl) ? 'interface' : 'class', members });
    } else if (ts.isTypeAliasDeclaration(decl)) {
      types.push({ ...base, kind: 'type', text: compact(decl.getText().replace(/^export\s+/, '')), members: [] });
    } else if (ts.isVariableDeclaration(decl)) {
      types.push({ ...base, kind: 'const', text: compact(`const ${decl.getText()}`), members: [] });
    } else if (ts.isFunctionDeclaration(decl)) {
      const text = decl.getText().replace(/^export\s+/, '');
      types.push({ ...base, kind: 'function', text: compact(text.slice(0, text.indexOf('{')).trim()), members: [] });
    }
  }

  const registry = createCommandRegistry(useCADStore);
  attachMacros(registry);
  return { version: API_VERSION, types, commands: registry.list() };
}

/** Public members without a doc comment: `Type.member` (or `Type` for undocumented root types). */
export function undocumented(model: ApiModel, roots: string[]): string[] {
  const missing: string[] = [];
  for (const t of model.types.filter(x => roots.includes(x.name))) {
    if (!t.doc) missing.push(t.name);
    for (const m of t.members) if (!m.doc) missing.push(`${t.name}.${m.name}`);
  }
  return missing;
}

/** The API surface reached from CasiWorksAPI: the root and its namespace interfaces. */
export function namespaceTypes(model: ApiModel): string[] {
  const root = model.types.find(t => t.name === 'CasiWorksAPI');
  if (!root) return [];
  const names = new Set(model.types.map(t => t.name));
  const reached = root.members.flatMap(m => (m.signature.match(/\b[A-Z]\w*API\b/g) ?? []).filter(n => names.has(n)));
  return ['CasiWorksAPI', ...new Set(reached)];
}

// ------------------------------------------------------------------ HTML
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderApiHtml(model: ApiModel): string {
  const names = new Set(model.types.map(t => t.name));
  const link = (code: string) => esc(code).replace(/\b([A-Z][A-Za-z0-9]*)\b/g, (m: string) => (names.has(m) ? `<a href="#${m}">${m}</a>` : m));
  const prose = (text: string) => esc(text).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n{2,}/g, '<br><br>');
  const tags = (list: DocTag[]) => list.map(t => (t.name === 'example'
    ? `<pre class="example"><code>${esc(t.text)}</code></pre>`
    : `<p class="tag"><b>@${esc(t.name)}</b> ${prose(t.text)}</p>`)).join('');

  const namespaces = namespaceTypes(model);
  const byName = new Map(model.types.map(t => [t.name, t]));
  const section = (t: DocType) => `
    <section class="type" id="${t.name}" data-search="${esc(`${t.name} ${t.members.map(m => m.name).join(' ')} ${t.doc}`.toLowerCase())}">
      <h3><span class="kind">${t.kind}</span> ${t.name}</h3>
      ${t.doc ? `<p>${prose(t.doc)}</p>` : ''}${tags(t.tags)}
      ${t.text ? `<pre><code>${link(t.text)}</code></pre>` : ''}
      ${t.members.length ? `<dl>${t.members.map(m => `
        <dt id="${t.name}.${m.name}"><code>${link(m.signature)}</code></dt>
        <dd>${m.doc ? prose(m.doc) : ''}${tags(m.tags)}</dd>`).join('')}</dl>` : ''}
      <p class="src">${esc(t.file)}</p>
    </section>`;

  const events = byName.get('CasiWorksEventMap');
  const others = model.types.filter(t => !namespaces.includes(t.name)).sort((a, b) => a.name.localeCompare(b.name));
  const categories = [...new Set(model.commands.map(c => c.category))];

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CasiWorks API ${esc(model.version)}</title>
<style>
  :root { --bg: #ffffff; --fg: #1f2933; --muted: #64748b; --line: #e2e8f0; --code: #f1f5f9; --accent: #0369a1; }
  @media (prefers-color-scheme: dark) { :root { --bg: #111318; --fg: #e5e7eb; --muted: #94a3b8; --line: #263041; --code: #1a1f2b; --accent: #38bdf8; } }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; }
  header { position: sticky; top: 0; background: var(--bg); border-bottom: 1px solid var(--line); padding: 12px 24px; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; z-index: 1; }
  header h1 { font-size: 18px; margin: 0; } header .v { color: var(--muted); font-size: 13px; }
  header input { margin-left: auto; padding: 6px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--code); color: var(--fg); min-width: 220px; }
  main { max-width: 980px; margin: 0 auto; padding: 8px 24px 64px; }
  nav { font-size: 13px; } nav a { margin-right: 10px; }
  a { color: var(--accent); text-decoration: none; } a:hover { text-decoration: underline; }
  h2 { margin-top: 40px; border-bottom: 1px solid var(--line); padding-bottom: 6px; }
  h3 { margin: 28px 0 6px; font-size: 17px; } .kind { color: var(--muted); font-weight: 400; font-size: 13px; }
  code, pre { font-family: ui-monospace, 'SFMono-Regular', Menlo, Consolas, monospace; font-size: 13px; }
  p code, dd code, td code { background: var(--code); padding: 1px 4px; border-radius: 3px; }
  pre { background: var(--code); padding: 10px 12px; border-radius: 6px; overflow-x: auto; }
  dl { margin: 8px 0 0; } dt { margin-top: 12px; } dt code { white-space: pre-wrap; word-break: break-word; }
  dd { margin: 4px 0 0 18px; color: var(--fg); }
  .src, .tag { color: var(--muted); font-size: 12px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; } th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { color: var(--muted); font-weight: 600; }
  .hidden { display: none; }
</style>
</head>
<body>
<header>
  <h1>CasiWorks Pro API</h1><span class="v">version ${esc(model.version)} · generated from the sources</span>
  <input id="q" type="search" placeholder="Filter types, members, commands…" aria-label="Filter">
</header>
<main>
  <nav><a href="#start">Getting started</a><a href="#namespaces">Namespaces</a><a href="#events">Events</a><a href="#commands">Commands</a><a href="#types">Types</a></nav>

  <h2 id="start">Getting started</h2>
  <p>In the app, the API is <code>window.casiworks</code>; the built-in console (Tools ▸ Console, <code>Ctrl+\`</code>) has it as <code>api</code>.
  Headless, import it from Node 22.18+: <code>import { createHeadlessAPI } from 'casiworks-pro/api'</code>.</p>
<pre><code>const api = window.casiworks;
const { sketchId } = api.sketches.create({
  entities: [{ type: 'rectangle', corner1: { x: -30, y: -20 }, corner2: { x: 30, y: 20 } }],
});
api.features.extrude({ sketchId, depth: 25 });
api.model.massProperties();   // { volume: 60000, mass: 0.474, … }
api.on('rebuild', (e) =&gt; console.log(e.ok));
api.commands.execute('view.isometric');</code></pre>
  <p>Units are millimetres, degrees and kilograms. Invalid calls throw <a href="#CasiWorksAPIError">CasiWorksAPIError</a> with a stable
  <a href="#CasiWorksAPIErrorCode">code</a>. Results are plain JSON data. <code>api.version</code> follows semantic versioning:
  minor versions only add, major versions may break.</p>

  <h2 id="namespaces">Namespaces</h2>
  ${namespaces.map(n => byName.get(n)).filter((t): t is DocType => !!t).map(section).join('')}

  <h2 id="events">Events</h2>
  <p>Listen with <code>api.on(name, handler)</code>; it returns a function that stops listening. Payloads:</p>
  ${events ? `<table><tr><th>Event</th><th>Payload</th><th></th></tr>${events.members.map(m => `<tr data-search="${esc(m.name.toLowerCase())}"><td><code>${esc(m.name)}</code></td><td><code>${link(m.signature.replace(/^[^:]+:\s*/, ''))}</code></td><td>${prose(m.doc)}</td></tr>`).join('')}</table>` : ''}

  <h2 id="commands">Commands</h2>
  <p>Run with <code>api.commands.execute(id, args)</code> (or <code>run(id, args)</code> in the console). Commands marked UI open dialogs or files and need the running app.</p>
  ${categories.map(cat => `<h3>${esc(cat)}</h3><table><tr><th>Id</th><th>Name</th><th>Keys</th><th>Arguments / notes</th></tr>${model.commands.filter(c => c.category === cat).map(c => `
    <tr data-search="${esc(`${c.id} ${c.label} ${c.description ?? ''}`.toLowerCase())}"><td><code>${esc(c.id)}</code></td><td>${esc(c.label)}${c.requiresUI ? ' <span class="tag">UI</span>' : ''}</td><td>${c.shortcuts.map(s => `<code>${esc(s)}</code>`).join(' ')}</td><td>${c.description ? prose(c.description) : ''}</td></tr>`).join('')}</table>`).join('')}

  <h2 id="types">Types</h2>
  ${others.filter(t => t.name !== 'CasiWorksEventMap').map(section).join('')}
</main>
<script>
  // Filter sections and table rows by the search text
  const q = document.getElementById('q');
  q.addEventListener('input', () => {
    const term = q.value.trim().toLowerCase();
    document.querySelectorAll('[data-search]').forEach(el => el.classList.toggle('hidden', !!term && !el.dataset.search.includes(term)));
  });
</script>
</body>
</html>
`;
}

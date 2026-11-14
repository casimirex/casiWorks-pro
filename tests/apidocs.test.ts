// CasiWorks Pro - The generated API reference covers and documents the whole public API
import test from 'node:test';
import assert from 'node:assert/strict';

import { readApiModel, renderApiHtml, undocumented, namespaceTypes } from '../scripts/apiDocs.ts';
import { API_VERSION } from '../src/api/CasiWorksAPI.ts';

const model = readApiModel();
const html = renderApiHtml(model);

test('API reference: every namespace and member of the public API has a doc comment', () => {
  const roots = namespaceTypes(model);
  for (const ns of ['CasiWorksAPI', 'DocumentAPI', 'SketchesAPI', 'FeaturesAPI', 'ModelAPI', 'MaterialsAPI', 'HistoryAPI', 'CommandsAPI', 'MacrosAPI']) {
    assert.ok(roots.includes(ns), `${ns} reached from CasiWorksAPI`);
  }
  assert.deepEqual(undocumented(model, roots), [], 'document these members (they appear in the API reference)');
});

test('API reference: page lists every member, event and command with the current version', () => {
  assert.ok(html.includes(`<title>CasiWorks API ${API_VERSION}</title>`));
  for (const t of namespaceTypes(model)) {
    for (const m of model.types.find(x => x.name === t)!.members) assert.ok(html.includes(`id="${t}.${m.name}"`), `${t}.${m.name}`);
  }
  for (const e of ['rebuild', 'featureAdded', 'selectionChanged', 'commandExecuted']) assert.ok(html.includes(`<code>${e}</code>`), e);
  assert.ok(model.commands.length > 60);
  for (const c of model.commands) assert.ok(html.includes(`<code>${c.id}</code>`), c.id);
  assert.ok(html.includes('<pre class="example">'), '@example blocks are rendered');
  assert.ok(!/>undefined</.test(html), 'no undefined text');
  assert.ok(html.includes('href="#FeatureInfo"'), 'type names link to their definitions');
});

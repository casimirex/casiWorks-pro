// CasiWorks Pro - Write the API reference to public/api/index.html (served at /api/)
import { mkdirSync, writeFileSync } from 'node:fs';
import { readApiModel, renderApiHtml, undocumented, namespaceTypes } from './apiDocs.ts';

const model = readApiModel();
mkdirSync('public/api', { recursive: true });
writeFileSync('public/api/index.html', renderApiHtml(model));
const missing = undocumented(model, namespaceTypes(model));
console.log(`API reference ${model.version}: ${model.types.length} types, ${model.commands.length} commands -> public/api/index.html`
  + (missing.length ? `\n  undocumented: ${missing.join(', ')}` : ''));

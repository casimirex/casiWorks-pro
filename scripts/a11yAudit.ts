// CasiWorks Pro - In-page accessibility audit (used by the e2e test)
//
// AUDIT is an expression run in the page: it lists visible controls a screen
// reader could not name (no text, label, aria-label or title), images without
// alt text, and dialogs without a name.
export const AUDIT = `(() => {
  const visible = (el) => !!(el.offsetParent || el.getClientRects().length) && getComputedStyle(el).visibility !== 'hidden';
  const text = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim();
  const nameOf = (el) => {
    const lb = el.getAttribute('aria-labelledby');
    if (lb) return lb.split(/\\s+/).map(id => text(document.getElementById(id) || document.createElement('i'))).join(' ').trim();
    if (el.getAttribute('aria-label')) return el.getAttribute('aria-label').trim();
    if (el.matches('input, select, textarea')) {
      if (el.id && document.querySelector('label[for="' + el.id + '"]')) return text(document.querySelector('label[for="' + el.id + '"]'));
      const wrap = el.closest('label');
      if (wrap && text(wrap)) return text(wrap);
      if (el.matches('input[type=button], input[type=submit]') && el.value) return el.value;
      return (el.title || el.placeholder || '').trim();
    }
    if (el.matches('img')) return (el.alt || '').trim();
    return text(el) || (el.title || '').trim() || [...el.querySelectorAll('img[alt], svg[aria-label]')].map(i => i.alt || i.getAttribute('aria-label')).join(' ').trim();
  };
  const describe = (el) => el.tagName.toLowerCase() + (el.className && typeof el.className === 'string' ? '.' + el.className.trim().split(/\\s+/).slice(0, 2).join('.') : '') + (el.closest('[class]') ? ' in ' + (el.parentElement?.className || '').toString().split(' ')[0] : '');
  const problems = [];
  const controls = document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=tab], [role=treeitem], [role=option], [role=combobox], [tabindex="0"]');
  for (const el of controls) {
    if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
    if (el.matches('input[type=checkbox], input[type=radio]') && el.closest('label') && text(el.closest('label'))) continue;
    if (!nameOf(el)) problems.push('unnamed ' + describe(el));
  }
  for (const img of document.querySelectorAll('img')) if (visible(img) && !img.hasAttribute('alt')) problems.push('img without alt: ' + img.src.slice(-40));
  for (const d of document.querySelectorAll('[role=dialog]')) if (visible(d) && !nameOf(d)) problems.push('unnamed dialog ' + describe(d));
  return [...new Set(problems)];
})()`;

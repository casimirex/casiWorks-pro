// CasiWorks Pro - Global variables and equations
//
// Variables are `name = expression`; a feature parameter can be an expression
// too (feature.expressions = { depth: '2 * wall' }). Expressions are parsed by
// a small recursive-descent parser, never eval: numbers, variable names,
// + - * / ^ ( ), unary minus, pi, and the functions below. Angles in sin/cos/tan
// are in degrees, as in the rest of the app. Lengths are millimetres.

export interface GlobalVariable {
  name: string;
  expression: string;
}

export class ExpressionError extends Error {}

const FUNCTIONS: Record<string, { args: [number, number]; fn: (...a: number[]) => number }> = {
  sqrt: { args: [1, 1], fn: Math.sqrt },
  abs: { args: [1, 1], fn: Math.abs },
  round: { args: [1, 1], fn: Math.round },
  floor: { args: [1, 1], fn: Math.floor },
  ceil: { args: [1, 1], fn: Math.ceil },
  sin: { args: [1, 1], fn: (d) => Math.sin(d * Math.PI / 180) },
  cos: { args: [1, 1], fn: (d) => Math.cos(d * Math.PI / 180) },
  tan: { args: [1, 1], fn: (d) => Math.tan(d * Math.PI / 180) },
  min: { args: [1, 16], fn: Math.min },
  max: { args: [1, 16], fn: Math.max },
};
const CONSTANTS: Record<string, number> = { pi: Math.PI };

/** Allowed variable names: a letter or _, then letters, digits or _ (not a function or constant name). */
export const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
export function variableNameProblem(name: string): string | null {
  if (!VARIABLE_NAME.test(name)) return `"${name}" is not a valid name: use letters, digits and _, starting with a letter`;
  if (name.toLowerCase() in FUNCTIONS || name.toLowerCase() in CONSTANTS) return `"${name}" is a built-in name`;
  return null;
}

type Token = { kind: 'num'; value: number } | { kind: 'name'; value: string } | { kind: 'op'; value: string };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) { out.push({ kind: 'num', value: parseFloat(num[0]) }); i += num[0].length; continue; }
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (name) { out.push({ kind: 'name', value: name[0] }); i += name[0].length; continue; }
    if ('+-*/^(),'.includes(c)) { out.push({ kind: 'op', value: c }); i++; continue; }
    throw new ExpressionError(`Unexpected "${c}"`);
  }
  return out;
}

/** A parsed expression: evaluate it with variable values, or list the names it uses. */
export interface Expression {
  names: Set<string>;
  evaluate(values: Record<string, number>): number;
}

export function parseExpression(src: string): Expression {
  const text = String(src ?? '').trim().replace(/^=/, '');
  if (!text) throw new ExpressionError('Empty expression');
  const tokens = tokenize(text);
  let pos = 0;
  const names = new Set<string>();
  const peek = () => tokens[pos];
  const isOp = (v: string) => peek()?.kind === 'op' && peek().value === v;
  const expect = (v: string) => { if (!isOp(v)) throw new ExpressionError(`Expected "${v}"`); pos++; };

  type Node = (vals: Record<string, number>) => number;
  // expr := term (('+'|'-') term)*
  const expr = (): Node => {
    let left = term();
    while (isOp('+') || isOp('-')) {
      const op = tokens[pos++].value; const l = left, r = term();
      left = op === '+' ? (v) => l(v) + r(v) : (v) => l(v) - r(v);
    }
    return left;
  };
  // term := unary (('*'|'/') unary)*
  const term = (): Node => {
    let left = unary();
    while (isOp('*') || isOp('/')) {
      const op = tokens[pos++].value; const l = left, r = unary();
      left = op === '*' ? (v) => l(v) * r(v) : (v) => {
        const d = r(v);
        if (d === 0) throw new ExpressionError('Division by zero');
        return l(v) / d;
      };
    }
    return left;
  };
  // unary := '-' unary | '+' unary | power
  const unary = (): Node => {
    if (isOp('-')) { pos++; const u = unary(); return (v) => -u(v); }
    if (isOp('+')) { pos++; return unary(); }
    return power();
  };
  // power := atom ('^' unary)?   (right-associative)
  const power = (): Node => {
    const base = atom();
    if (isOp('^')) { pos++; const ex = unary(); return (v) => Math.pow(base(v), ex(v)); }
    return base;
  };
  const atom = (): Node => {
    const t = peek();
    if (!t) throw new ExpressionError('Unexpected end of expression');
    if (t.kind === 'num') { pos++; const n = t.value; return () => n; }
    if (t.kind === 'op' && t.value === '(') { pos++; const e = expr(); expect(')'); return e; }
    if (t.kind === 'name') {
      pos++;
      const lower = t.value.toLowerCase();
      if (isOp('(')) {
        const f = FUNCTIONS[lower];
        if (!f) throw new ExpressionError(`Unknown function "${t.value}"`);
        pos++;
        const args: Node[] = [];
        if (!isOp(')')) {
          args.push(expr());
          while (isOp(',')) { pos++; args.push(expr()); }
        }
        expect(')');
        if (args.length < f.args[0] || args.length > f.args[1]) throw new ExpressionError(`${lower}() takes ${f.args[0] === f.args[1] ? f.args[0] : `${f.args[0]}–${f.args[1]}`} argument${f.args[1] === 1 ? '' : 's'}`);
        return (v) => f.fn(...args.map(a => a(v)));
      }
      if (lower in CONSTANTS) { const c = CONSTANTS[lower]; return () => c; }
      const name = t.value;
      names.add(name);
      return (v) => {
        if (!(name in v)) throw new ExpressionError(`Unknown variable "${name}"`);
        return v[name];
      };
    }
    throw new ExpressionError(`Unexpected "${t.value}"`);
  };

  const root = expr();
  if (pos < tokens.length) throw new ExpressionError(`Unexpected "${tokens[pos].value}"`);
  return {
    names,
    evaluate(values) {
      const r = root(values);
      if (!Number.isFinite(r)) throw new ExpressionError('The result is not a finite number');
      return r;
    },
  };
}

/** Evaluate one expression; throws ExpressionError with a readable message. */
export function evaluateExpression(src: string, values: Record<string, number> = {}): number {
  return parseExpression(src).evaluate(values);
}

/** True when the text is just a number (no expression to keep). */
export const isPlainNumber = (text: string) => /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?\s*$/.test(text);

export interface VariableResult {
  values: Record<string, number>;
  /** Problems by variable name (bad name, duplicate, syntax, unknown name, cycle, …). */
  errors: Record<string, string>;
}

/** Values of all variables, each after the ones it uses; cycles and errors are reported per variable. */
export function evaluateVariables(variables: GlobalVariable[]): VariableResult {
  const values: Record<string, number> = {};
  const errors: Record<string, string> = {};
  const parsed = new Map<string, Expression>();
  for (const v of variables) {
    const problem = variableNameProblem(v.name);
    if (problem) { errors[v.name] = problem; continue; }
    if (parsed.has(v.name) || v.name in errors) { errors[v.name] = `"${v.name}" is defined twice`; parsed.delete(v.name); continue; }
    try { parsed.set(v.name, parseExpression(v.expression)); } catch (e) { errors[v.name] = (e as Error).message; }
  }
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new ExpressionError(`Circular: ${[...path, name].join(' → ')}`);
    const ex = parsed.get(name)!;
    state.set(name, 'visiting');
    for (const dep of ex.names) {
      if (!parsed.has(dep)) throw new ExpressionError(errors[dep] ? `Uses "${dep}", which has an error` : `Unknown variable "${dep}"`);
      visit(dep, [...path, name]);
    }
    values[name] = ex.evaluate(values);
    state.set(name, 'done');
  };
  for (const name of parsed.keys()) {
    try { visit(name, []); } catch (e) {
      // Everything on a failed path is unresolved
      for (const [n, s] of state) if (s === 'visiting') { state.delete(n); if (!(n in values)) errors[n] ??= (e as Error).message; }
      errors[name] ??= (e as Error).message;
    }
  }
  return { values, errors };
}

/** Parameters that must be whole numbers. */
const INTEGER_PARAMS = new Set(['count']);

export interface LinkedParameter {
  featureId: string;
  featureName: string;
  parameter: string;
  expression: string;
  value: number | null;
  error?: string;
}

/**
 * Work out every feature parameter linked to an expression. Returns the new
 * numbers to write (featureId → { param: value }) and a row per link for display.
 */
export function evaluateLinks(
  features: Array<{ id: string; name: string; expressions?: Record<string, string> }>,
  values: Record<string, number>,
): { updates: Record<string, Record<string, number>>; links: LinkedParameter[] } {
  const updates: Record<string, Record<string, number>> = {};
  const links: LinkedParameter[] = [];
  for (const f of features) {
    for (const [parameter, expression] of Object.entries(f.expressions ?? {})) {
      try {
        let value = evaluateExpression(expression, values);
        if (INTEGER_PARAMS.has(parameter)) value = Math.round(value);
        (updates[f.id] ??= {})[parameter] = value;
        links.push({ featureId: f.id, featureName: f.name, parameter, expression, value });
      } catch (e) {
        links.push({ featureId: f.id, featureName: f.name, parameter, expression, value: null, error: (e as Error).message });
      }
    }
  }
  return { updates, links };
}

// ------------------------------------------------------------------ configurations

/** A named variant of the part: variable expressions that replace the defaults while it is active. */
export interface Configuration {
  name: string;
  /** variable name → expression; variables not listed keep their default. */
  values: Record<string, string>;
}

/** The variables as a configuration sees them (unknown names in the configuration are ignored). */
export function effectiveVariables(variables: GlobalVariable[], configuration: Configuration | null | undefined): GlobalVariable[] {
  if (!configuration) return variables;
  return variables.map(v => (Object.prototype.hasOwnProperty.call(configuration.values, v.name) && configuration.values[v.name].trim() !== ''
    ? { name: v.name, expression: configuration.values[v.name] }
    : v));
}

/** Problems with a set of configurations (empty when they are fine). */
export function configurationProblems(variables: GlobalVariable[], configurations: Configuration[]): string[] {
  const problems: string[] = [];
  const names = new Set<string>();
  const known = new Set(variables.map(v => v.name));
  for (const c of configurations) {
    const name = c.name.trim();
    if (!name) { problems.push('A configuration needs a name'); continue; }
    if (name.toLowerCase() === 'default') problems.push('"Default" is reserved for the plain variable values');
    if (names.has(name)) problems.push(`"${name}" is used twice`);
    names.add(name);
    for (const v of Object.keys(c.values)) if (!known.has(v)) problems.push(`${name}: no variable "${v}"`);
    const { errors } = evaluateVariables(effectiveVariables(variables, c));
    for (const [v, m] of Object.entries(errors)) problems.push(`${name}: ${v}: ${m}`);
  }
  return problems;
}

/** Sketch dimensions linked to expressions, listed like feature parameters (parameter 'dimension'). */
export function dimensionLinks(
  features: Array<{ id: string; name: string; type: string; sketchId?: string }>,
  sketchConstraints: Record<string, unknown[]>,
  values: Record<string, number>,
): LinkedParameter[] {
  const out: LinkedParameter[] = [];
  for (const f of features) {
    if (f.type !== 'sketch' || !f.sketchId) continue;
    for (const c of (sketchConstraints[f.sketchId] ?? []) as Array<{ type?: string; expression?: string; diameter?: boolean }>) {
      if (c.type !== 'dimension' || !c.expression) continue;
      const parameter = c.diameter ? 'dimension Ø' : 'dimension';
      try {
        out.push({ featureId: f.id, featureName: f.name, parameter, expression: c.expression, value: evaluateExpression(c.expression, values) });
      } catch (e) {
        out.push({ featureId: f.id, featureName: f.name, parameter, expression: c.expression, value: null, error: (e as Error).message });
      }
    }
  }
  return out;
}

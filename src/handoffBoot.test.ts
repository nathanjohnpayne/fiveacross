// Covers specs/auth-handoff-client.md § Leg 3 — the capture that has to happen
// before the application's module graph loads (Phase 4b P1).
//
// The property under test is an ORDERING one that line order inside `main.tsx`
// could never provide: ES modules evaluate their static imports before their
// own body, so `firebase.ts` (and with it GA4) was already live on a URL still
// carrying the code. `entry.tsx` captures with nothing else loaded and reaches
// the app through a dynamic import; this file holds the seam they share.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  hasHandoffFragment: vi.fn(),
  readHandoffCode: vi.fn(),
  hasEventInvitationFragment: vi.fn(),
  capturePendingEventInvitation: vi.fn(),
  clearUrlFragmentAndConfirm: vi.fn(),
}));

vi.mock('./auth/handoffClient', () => ({
  hasHandoffFragment: mocks.hasHandoffFragment,
  readHandoffCode: mocks.readHandoffCode,
}));

vi.mock('./pendingEventInvitation', () => ({
  hasEventInvitationFragment: mocks.hasEventInvitationFragment,
  capturePendingEventInvitation: mocks.capturePendingEventInvitation,
}));

vi.mock('./urlFragment', () => ({
  clearUrlFragmentAndConfirm: mocks.clearUrlFragmentAndConfirm,
}));

const CODE = 'C'.repeat(43);
const INVITATION = 'I'.repeat(43);

/** Read a repo file as text. Vitest runs from the repo root. */
function readSource(relative: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return readFileSync(resolve(process.cwd(), relative), 'utf8');
}

interface RuntimeModuleImport {
  kind: 'static' | 'dynamic';
  /** `null` means a computed dynamic import, which the guard rejects. */
  specifier: string | null;
  offset: number;
}

function importClauseHasRuntimeValue(clause: ts.ImportClause | undefined): boolean {
  // `import './side-effect'` has no clause and always evaluates the target.
  if (clause === undefined) return true;
  if (clause.isTypeOnly) return false;
  if (clause.name !== undefined) return true;
  if (clause.namedBindings === undefined) return true;
  if (ts.isNamespaceImport(clause.namedBindings)) return true;
  // `import {} from './module'` still evaluates the module. A named import made
  // only of `type` specifiers is the sole remaining erased form.
  return (
    clause.namedBindings.elements.length === 0 ||
    clause.namedBindings.elements.some((element) => !element.isTypeOnly)
  );
}

function exportClauseHasRuntimeValue(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false;
  if (node.exportClause === undefined || ts.isNamespaceExport(node.exportClause)) return true;
  return (
    node.exportClause.elements.length === 0 ||
    node.exportClause.elements.some((element) => !element.isTypeOnly)
  );
}

/** AST extraction avoids regex blind spots for side-effect and multiline imports. */
function extractRuntimeModuleImports(source: string, fileName: string): RuntimeModuleImport[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const imports: RuntimeModuleImport[] = [];

  function visit(node: ts.Node): void {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      importClauseHasRuntimeValue(node.importClause)
    ) {
      imports.push({
        kind: 'static',
        specifier: node.moduleSpecifier.text,
        offset: node.getStart(sourceFile),
      });
    } else if (
      ts.isImportEqualsDeclaration(node) &&
      !node.isTypeOnly &&
      ts.isExternalModuleReference(node.moduleReference) &&
      node.moduleReference.expression !== undefined &&
      ts.isStringLiteralLike(node.moduleReference.expression)
    ) {
      imports.push({
        kind: 'static',
        specifier: node.moduleReference.expression.text,
        offset: node.getStart(sourceFile),
      });
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier) &&
      exportClauseHasRuntimeValue(node)
    ) {
      imports.push({
        kind: 'static',
        specifier: node.moduleSpecifier.text,
        offset: node.getStart(sourceFile),
      });
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      imports.push({
        kind: 'dynamic',
        specifier:
          argument !== undefined && ts.isStringLiteralLike(argument) ? argument.text : null,
        offset: node.getStart(sourceFile),
      });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return imports.sort((left, right) => left.offset - right.offset);
}

const MODULE_FILE_SUFFIXES = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'] as const;

function repoRelativePath(absolutePath: string): string {
  return relative(process.cwd(), absolutePath).split('\\').join('/');
}

function resolveRuntimeStaticImport(fromFile: string, specifier: string): string {
  if (!specifier.startsWith('.')) {
    throw new Error(
      `pre-analytics graph has non-local runtime import ${specifier} from ${fromFile}`,
    );
  }
  const unresolved = resolve(process.cwd(), dirname(fromFile), specifier);
  const candidates = [
    unresolved,
    ...MODULE_FILE_SUFFIXES.map((suffix) => `${unresolved}${suffix}`),
    ...MODULE_FILE_SUFFIXES.map((suffix) => resolve(unresolved, `index${suffix}`)),
  ];
  const match = candidates.find(
    (candidate) => existsSync(candidate) && statSync(candidate).isFile(),
  );
  if (match === undefined) {
    throw new Error(`cannot resolve runtime import ${specifier} from ${fromFile}`);
  }
  return repoRelativePath(match);
}

function runtimeStaticImportGraph(entryFile: string): Map<string, RuntimeModuleImport[]> {
  const graph = new Map<string, RuntimeModuleImport[]>();
  const pending = [entryFile];

  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || graph.has(file)) continue;
    const imports = extractRuntimeModuleImports(readSource(file), file);
    graph.set(file, imports);
    for (const dependency of imports.filter((entry) => entry.kind === 'static')) {
      if (dependency.specifier === null)
        throw new Error(`missing static import specifier in ${file}`);
      pending.push(resolveRuntimeStaticImport(file, dependency.specifier));
    }
  }

  return graph;
}

function callOffsets(source: string, fileName: string, calleeName: string): number[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const offsets: number[] = [];
  function visit(node: ts.Node): void {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === calleeName
    ) {
      offsets.push(node.getStart(sourceFile));
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return offsets;
}

async function freshBoot() {
  vi.resetModules();
  return import('./handoffBoot');
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.hasHandoffFragment.mockReturnValue(false);
  mocks.readHandoffCode.mockReturnValue(null);
  mocks.hasEventInvitationFragment.mockReturnValue(false);
  mocks.capturePendingEventInvitation.mockReturnValue(null);
  mocks.clearUrlFragmentAndConfirm.mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('handoffBoot', () => {
  it('captures the code and clears it', async () => {
    mocks.hasHandoffFragment.mockReturnValue(true);
    mocks.readHandoffCode.mockReturnValue(CODE);
    const boot = await freshBoot();
    boot.captureUrlCredentialsFromUrl();
    expect(boot.pendingHandoffCode()).toBe(CODE);
    expect(mocks.clearUrlFragmentAndConfirm).toHaveBeenCalledTimes(1);
    expect(boot.isUrlSafeForTelemetry()).toBe(true);
  });

  it('stores an invitation before clearing the fragment', async () => {
    mocks.hasEventInvitationFragment.mockReturnValue(true);
    const order: string[] = [];
    mocks.capturePendingEventInvitation.mockImplementation(() => {
      order.push('capture');
      return {
        record: { code: INVITATION, origin: window.location.origin, capturedAt: 1 },
        durable: true,
      };
    });
    mocks.clearUrlFragmentAndConfirm.mockImplementation(() => {
      order.push('clear');
      return true;
    });
    const boot = await freshBoot();

    boot.captureUrlCredentialsFromUrl();

    expect(order).toEqual(['capture', 'clear']);
    expect(mocks.capturePendingEventInvitation).toHaveBeenCalledWith({
      hash: window.location.hash,
      origin: window.location.origin,
      now: expect.any(Number),
    });
    expect(boot.isUrlSafeForTelemetry()).toBe(true);
  });

  it('does not touch the fragment on an ordinary load', async () => {
    const boot = await freshBoot();
    boot.captureUrlCredentialsFromUrl();
    expect(boot.pendingHandoffCode()).toBeNull();
    expect(mocks.clearUrlFragmentAndConfirm).not.toHaveBeenCalled();
    // An ordinary load has no code to leak, so telemetry is unaffected.
    expect(boot.isUrlSafeForTelemetry()).toBe(true);
  });

  it('marks the URL unsafe when the clear could not be confirmed', async () => {
    mocks.hasHandoffFragment.mockReturnValue(true);
    mocks.readHandoffCode.mockReturnValue(CODE);
    mocks.clearUrlFragmentAndConfirm.mockReturnValue(false);
    const boot = await freshBoot();
    boot.captureUrlCredentialsFromUrl();
    // The code is still returned — sign-in must still complete…
    expect(boot.pendingHandoffCode()).toBe(CODE);
    // …but nothing may read the URL.
    expect(boot.isUrlSafeForTelemetry()).toBe(false);
  });

  it('clears and suppresses telemetry for a tagged value that is not redeemable', async () => {
    mocks.hasEventInvitationFragment.mockReturnValue(true);
    mocks.clearUrlFragmentAndConfirm.mockReturnValue(false);
    const boot = await freshBoot();

    boot.captureUrlCredentialsFromUrl();

    expect(mocks.capturePendingEventInvitation).toHaveBeenCalledWith({
      hash: window.location.hash,
      origin: window.location.origin,
      now: expect.any(Number),
    });
    expect(mocks.clearUrlFragmentAndConfirm).toHaveBeenCalledTimes(1);
    expect(boot.isUrlSafeForTelemetry()).toBe(false);
  });

  // A second call would read an already-cleared URL and overwrite a real
  // capture with null, turning a working sign-in into `transaction-missing`.
  it('is idempotent', async () => {
    mocks.hasHandoffFragment.mockReturnValue(true);
    mocks.readHandoffCode.mockReturnValueOnce(CODE).mockReturnValue(null);
    const boot = await freshBoot();
    boot.captureUrlCredentialsFromUrl();
    boot.captureUrlCredentialsFromUrl();
    expect(boot.pendingHandoffCode()).toBe(CODE);
    expect(mocks.readHandoffCode).toHaveBeenCalledTimes(1);
    expect(mocks.hasEventInvitationFragment).toHaveBeenCalledTimes(1);
    expect(mocks.clearUrlFragmentAndConfirm).toHaveBeenCalledTimes(1);
  });
});

describe('the entry seam stays free of anything that can read a URL', () => {
  it('extracts side-effect, re-export, and dynamic imports without matching dead text', () => {
    const imports = extractRuntimeModuleImports(
      `
        import type { Erased } from './types';
        import { type AlsoErased } from './more-types';
        import './side-effect';
        export { live } from './re-export';
        const deadText = "import('./not-an-import')";
        void import('./dynamic');
        void import(computedSpecifier);
      `,
      'fixture.ts',
    );

    expect(imports.map(({ kind, specifier }) => ({ kind, specifier }))).toEqual([
      { kind: 'static', specifier: './side-effect' },
      { kind: 'static', specifier: './re-export' },
      { kind: 'dynamic', specifier: './dynamic' },
      { kind: 'dynamic', specifier: null },
    ]);
  });

  // The guarantee is transitive: a harmless-looking side-effect import added
  // anywhere below handoffBoot can otherwise wake analytics before entry's body.
  it('keeps the complete runtime-static entry graph inside the credential-safe seam', () => {
    const graph = runtimeStaticImportGraph('src/entry.tsx');
    expect([...graph.keys()].sort()).toEqual(
      [
        'src/entry.tsx',
        'src/handoffBoot.ts',
        'src/auth/handoffClient.ts',
        'src/auth/handoffTransaction.ts',
        'src/pendingEventInvitation.ts',
        'src/urlFragment.ts',
      ].sort(),
    );

    for (const [file, imports] of graph) {
      if (file === 'src/entry.tsx') continue;
      expect(
        imports.filter((entry) => entry.kind === 'dynamic'),
        `${file} cannot start an uninspected module before credential capture`,
      ).toEqual([]);
    }
  });

  it('allows only the two inspected entry imports, both after credential capture', () => {
    const src = readSource('src/entry.tsx');
    const imports = extractRuntimeModuleImports(src, 'src/entry.tsx');
    expect(
      imports.filter((entry) => entry.kind === 'static').map((entry) => entry.specifier),
    ).toEqual(['./handoffBoot']);

    const dynamicImports = imports.filter((entry) => entry.kind === 'dynamic');
    expect(dynamicImports.map((entry) => entry.specifier)).toEqual([
      './auth/handoffReturn',
      './main',
    ]);
    const captureOffsets = callOffsets(src, 'src/entry.tsx', 'captureUrlCredentialsFromUrl');
    expect(captureOffsets).toHaveLength(1);
    for (const dynamicImport of dynamicImports) {
      expect(dynamicImport.offset).toBeGreaterThan(captureOffsets[0]);
    }
  });
});

describe('dependency-free bootstrap failures', () => {
  it('never imports the app after a recovery result', async () => {
    const boot = await freshBoot();
    const loadMain = vi.fn().mockResolvedValue(undefined);
    const renderFailure = vi.fn();

    await boot.runApplicationBootstrap({
      code: CODE,
      completeHandoff: vi.fn().mockResolvedValue({ kind: 'recover' }),
      loadMain,
      renderFailure,
    });

    expect(loadMain).not.toHaveBeenCalled();
    expect(renderFailure).toHaveBeenCalledOnce();
    expect(renderFailure).toHaveBeenCalledWith('handoff-recovery');
  });

  it('never imports the app after an unexpected handoff failure', async () => {
    const boot = await freshBoot();
    const loadMain = vi.fn().mockResolvedValue(undefined);
    const renderFailure = vi.fn();

    await boot.runApplicationBootstrap({
      code: CODE,
      completeHandoff: vi.fn().mockRejectedValue(new Error('return module failed')),
      loadMain,
      renderFailure,
    });

    expect(loadMain).not.toHaveBeenCalled();
    expect(renderFailure).toHaveBeenCalledWith('handoff-recovery');
  });

  it('renders recovery with exactly one reload action', async () => {
    document.body.innerHTML = '<div id="root">Loading</div>';
    const boot = await freshBoot();

    boot.renderBootstrapFailure('handoff-recovery');

    const alert = document.querySelector('[role="alert"]');
    expect(alert).toHaveTextContent('Finish signing in');
    expect(alert).toHaveTextContent('cannot confirm it safely');
    expect(alert?.querySelectorAll('button')).toHaveLength(1);
    expect(alert?.querySelector('button')).toHaveTextContent('Reload');
  });

  it('keeps ordinary chunk failure free of a misleading handoff action', async () => {
    document.body.innerHTML = '<div id="root">Loading</div>';
    const boot = await freshBoot();

    boot.renderBootstrapFailure('app-load');

    const alert = document.querySelector('[role="alert"]');
    expect(alert).toHaveTextContent("This didn't load");
    expect(alert?.querySelector('button')).toBeNull();
  });
});

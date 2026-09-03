import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

interface StaticImportClosure {
  modules: Set<string>;
  packages: Set<string>;
}

function resolveLocalImport(importer: string, specifier: string): string {
  const base = resolve(dirname(importer), specifier);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    resolve(base, 'index.ts'),
    resolve(base, 'index.tsx'),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (found === undefined) throw new Error(`Cannot resolve ${specifier} from ${importer}`);
  return found;
}

/** Follow real TypeScript import declarations, excluding dynamic and type-only imports. */
function staticImportClosure(root: string): StaticImportClosure {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const pending = [resolve(root)];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (modules.has(file)) continue;
    modules.add(file);
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || statement.importClause?.isTypeOnly) continue;
      if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier.startsWith('.')) pending.push(resolveLocalImport(file, specifier));
      else packages.add(specifier);
    }
  }
  return { modules, packages };
}

function repoModules(closure: StaticImportClosure): string[] {
  return [...closure.modules].map((file) => relative(process.cwd(), file)).sort();
}

describe('production handoff return boundary', () => {
  it('keeps page Auth outside the complete recursive pre-commit graph', () => {
    const source = readFileSync('src/auth/handoffReturn.ts', 'utf8');
    const closure = staticImportClosure('src/auth/handoffReturn.ts');
    const modules = repoModules(closure);

    expect(modules).not.toContain('src/firebaseAuth.ts');
    expect(modules).not.toContain('src/firebase.ts');
    expect(modules).not.toContain('src/main.tsx');
    expect([...closure.packages]).not.toContain('firebase/auth');
    expect(source).toMatch(/new Worker\(new URL\('\.\/handoffCommit\.worker\.ts'/);
    expect(source).toMatch(/navigator\.locks/);
    expect(source).toMatch(/indexedDB/);
  });

  it('keeps the fragment-clearing entry graph free of the app and Firebase', () => {
    const closure = staticImportClosure('src/entry.tsx');
    const modules = repoModules(closure);

    expect(modules).toEqual([
      'src/auth/handoffClient.ts',
      'src/auth/handoffTransaction.ts',
      'src/entry.tsx',
      'src/handoffBoot.ts',
      'src/pendingEventInvitation.ts',
      'src/urlFragment.ts',
    ]);
    expect([...closure.packages]).toEqual([]);
  });

  it('keeps every primary Auth mutation inside the disposable Worker adapter', () => {
    const pageFiles = [
      'src/entry.tsx',
      'src/auth/handoffReturn.ts',
      'src/auth/handoffReturnCoordinator.ts',
      'src/auth/handoffPageAuthObserver.ts',
      'src/auth/handoffExchange.ts',
    ];
    for (const file of pageFiles) {
      expect(readFileSync(file, 'utf8'), file).not.toMatch(
        /\b(?:updateCurrentUser|signOut|setPersistence)\b/,
      );
    }

    const adapter = readFileSync('src/auth/firebaseHandoffCommitWorkerAdapter.ts', 'utf8');
    expect(adapter).toMatch(
      /async commit\(\)[\s\S]*const persistentApp = initializeApp\(firebaseOptions\)[\s\S]*await updateCurrentUser\(persistentAuth, candidateUser\)/,
    );
  });

  it('keeps the Worker graph free of page-only product dependencies', () => {
    const closure = staticImportClosure('src/auth/handoffCommit.worker.ts');
    const modules = repoModules(closure);
    for (const banned of [
      'src/firebase.ts',
      'src/firebaseAuth.ts',
      'src/firebaseCore.ts',
      'src/main.tsx',
      'src/auth/handoffReturn.ts',
      'src/auth/handoffPageAuthObserver.ts',
    ]) {
      expect(modules).not.toContain(banned);
    }
    for (const dependency of closure.packages) {
      expect(dependency).not.toMatch(
        /(?:react|posthog|analytics|firebase\/(?:firestore|storage|app-check))/i,
      );
    }
    const protocol = readFileSync('src/auth/handoffCommitProtocol.ts', 'utf8');
    expect(protocol).toContain('refreshTokenDigest');
    expect(protocol).not.toMatch(/\brefreshToken\s*:/);
  });
});

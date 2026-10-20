/**
 * Garde : le nom du logiciel concurrent (et de son éditeur) n'apparaît dans aucun texte
 * de l'interface. Seules les chaînes (littéraux, gabarits, texte JSX) sont lues : les
 * commentaires, identifiants et noms de fichiers source restent libres.
 *
 * Exceptions (invisibles pour l'utilisateur) : identifiants internes (préréglage de
 * raccourcis, bases IndexedDB, clé de stockage) et mots-clés de recherche de la palette
 * (propriété `keywords`, jamais affichée : ils permettent de retrouver l'échange AAF).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import ts from 'typescript';

const ROOT = path.resolve(__dirname, '..');
const DIRS = ['components', 'hooks', 'utils', 'services', 'engine', 'plugins'];
const FILES = ['App.tsx', 'index.tsx', 'ecoute.tsx', 'morceau.tsx', 'types.ts'];
const BRAND = /pro ?tools|pro-tools|\bavid\b/i;
const SIGLE = /\bPT\b/;
const INTERNES = new Set(['protools', 'nova-protools', 'nova_protools_bridge']);

function sources(): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e.name) && !e.name.endsWith('.d.ts')) out.push(p);
    }
  };
  for (const d of DIRS) if (fs.existsSync(path.join(ROOT, d))) walk(path.join(ROOT, d));
  for (const f of FILES) if (fs.existsSync(path.join(ROOT, f))) out.push(path.join(ROOT, f));
  return out;
}

function chainesFautives(file: string): string[] {
  const text = fs.readFileSync(file, 'utf8');
  if (!BRAND.test(text) && !SIGLE.test(text)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const bad: string[] = [];
  const visit = (n: ts.Node) => {
    let t: string | null = null;
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) t = n.text;
    else if (n.kind === ts.SyntaxKind.JsxText) t = n.getText();
    if (t && (BRAND.test(t) || SIGLE.test(t))) {
      const p = n.parent;
      const importe = p && (ts.isImportDeclaration(p) || ts.isExportDeclaration(p));
      const motsCles = p && ts.isPropertyAssignment(p) && p.name.getText() === 'keywords';
      if (!importe && !motsCles && !INTERNES.has(t)) {
        const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
        bad.push(`${path.relative(ROOT, file)}:${line + 1} ${JSON.stringify(t).slice(0, 120)}`);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return bad;
}

describe('aucun nom de concurrent dans les textes de l’interface', () => {
  it('chaînes, infobulles, notifications et textes JSX', () => {
    const bad = sources().flatMap(chainesFautives);
    expect(bad).toEqual([]);
  });
});

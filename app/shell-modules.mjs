import ts from 'typescript';

/** Walk emitted application JS. The build supplies images, worker and vendor files separately. */
export function shellModules(sources, supplied = new Set(), entry = 'main.js') {
  const reachable = new Set(), lazy = new Set();
  function dependency(path, parent, follow) {
    const name = path.startsWith('./') ? path.slice(2) : null;
    if (name && sources.has(name)) follow(name);
    else if (!name || !supplied.has(name)) throw Error('Unknown offline module '+path+' in '+parent+'.');
  }
  function visit(name) {
    if (reachable.has(name)) return;
    reachable.add(name);
    const text = sources.get(name).toString();
    const source = ts.createSourceFile(name,text,ts.ScriptTarget.Latest,false,ts.ScriptKind.JS);
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      const path = node.moduleSpecifier;
      if (path && ts.isStringLiteral(path)) dependency(path.text, name, visit);
    }
    function lazyImports(node) {
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const path = node.arguments[0];
        if (!path || !ts.isStringLiteralLike(path)) throw Error('Cannot identify the offline import in '+name+'. Use an explicit module path.');
        dependency(path.text, name, target => lazy.add(target));
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Worker') {
        const url = node.arguments?.[0];
        const [path,base] = url && ts.isNewExpression(url) && ts.isIdentifier(url.expression) && url.expression.text === 'URL'
          ? url.arguments ?? [] : [];
        if (!path || !ts.isStringLiteralLike(path) || !base || !ts.isPropertyAccessExpression(base) || base.name.text !== 'url' ||
            !ts.isMetaProperty(base.expression) || base.expression.keywordToken !== ts.SyntaxKind.ImportKeyword) {
          throw Error('Cannot identify the offline worker in '+name+'. Use a module-relative URL.');
        }
        dependency(path.text, name, target => lazy.add(target));
      }
      ts.forEachChild(node,lazyImports);
    }
    ts.forEachChild(source,lazyImports);
  }
  visit(entry);
  const startup = [...reachable].filter(name => name !== entry);
  for (const name of lazy) visit(name);
  return {reachable,startup};
}

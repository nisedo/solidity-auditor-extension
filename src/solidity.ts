import * as path from 'node:path';
import * as vscode from 'vscode';

const parser = require('@solidity-parser/parser');

export interface FunctionSummary {
  name: string;
  label: string;
  detail: string;
  contractName: string;
  inherited: boolean;
  location?: vscode.Location;
}

export interface VariableSummary {
  name: string;
  detail: string;
  inherited: boolean;
  isConstant: boolean;
  isImmutable: boolean;
  location?: vscode.Location;
  modifiedBy: FunctionSummary[];
}

export interface ContractAnalysis {
  contractName: string;
  cockpitItems: FunctionSummary[];
  variables: VariableSummary[];
  diagnostics: vscode.Diagnostic[];
  decorations: {
    immutable: vscode.Range[];
    constant: vscode.Range[];
    mutable: vscode.Range[];
  };
}

interface ParsedImport {
  path: string;
  symbolAliases: ImportAlias[];
  unitAlias?: string;
  location?: SourceLocation;
  resolvedUri?: vscode.Uri;
}

interface ImportAlias {
  foreign: string;
  local: string;
  location?: SourceLocation;
}

interface ParsedFile {
  uri: vscode.Uri;
  ast: any;
  source: string;
  imports: ParsedImport[];
  contracts: ContractInfo[];
  topLevelStructs: StructInfo[];
  topLevelNames: string[];
}

interface ContractInfo {
  name: string;
  kind: string;
  uri: vscode.Uri;
  location?: SourceLocation;
  baseNames: string[];
  usingLibraries: string[];
  stateVariables: StateVariableInfo[];
  structs: StructInfo[];
  functions: FunctionInfo[];
}

interface StateVariableInfo {
  name: string;
  isConstant: boolean;
  isImmutable: boolean;
  typeName?: string;
  uri: vscode.Uri;
  location?: SourceLocation;
  nameRange?: number[];
  constantValueText?: string;
  contractName: string;
}

interface FunctionInfo {
  id: string;
  name: string;
  label: string;
  parameters: ParameterInfo[];
  variableTypes: Map<string, string>;
  visibility: string;
  stateMutability: string;
  hasBody: boolean;
  contractName: string;
  uri: vscode.Uri;
  location?: SourceLocation;
  directModifies: Set<string>;
  calls: Set<string>;
}

interface ParameterInfo {
  name?: string;
  typeName?: string;
}

interface StructInfo {
  name: string;
  fields: ParameterInfo[];
  contractName?: string;
  uri: vscode.Uri;
  location?: SourceLocation;
}

interface SourceLocation {
  start: {
    line: number;
    column: number;
  };
  end: {
    line: number;
    column: number;
  };
}

export function isSolidityDocument(document: vscode.TextDocument): boolean {
  return document.languageId === 'solidity' || document.uri.fsPath.endsWith('.sol');
}

export async function analyzeActiveContract(
  document: vscode.TextDocument,
  position: vscode.Position
): Promise<ContractAnalysis | undefined> {
  if (!isSolidityDocument(document)) {
    return undefined;
  }

  const { currentFile, allFiles, contractMap, filesByUri } = await loadDocumentContext(document);
  const currentContract = findActiveContract(currentFile.contracts, position) ?? currentFile.contracts[0];

  if (!currentContract) {
    return {
      contractName: 'No contract',
      cockpitItems: [],
      variables: [],
      diagnostics: buildDiagnostics(currentFile, filesByUri),
      decorations: { immutable: [], constant: [], mutable: [] }
    };
  }

  const lineage = resolveLineage(currentContract, contractMap);
  const publicFunctions = buildPublicFunctionList(currentContract, lineage);
  const transitiveModifies = buildTransitiveModificationMap(lineage);
  const cockpitItems = publicFunctions.map((item) => {
    const modifies = transitiveModifies.get(item.id) ?? new Set<string>();
    return {
      name: item.name,
      label: item.label,
      detail: `${item.visibility} ${item.stateMutability} | ${item.contractName}${item.inherited ? ' (inherited)' : ''} | ${modifies.size} state vars`,
      contractName: item.contractName,
      inherited: item.inherited,
      location: toLocation(item.uri, item.location)
    };
  });

  const variables = buildVariableList(currentContract, lineage, cockpitItems, publicFunctions, transitiveModifies);
  const diagnostics = buildDiagnostics(currentFile, filesByUri);
  const decorations = buildSemanticDecorations(document, currentContract, lineage);

  return {
    contractName: currentContract.name,
    cockpitItems,
    variables,
    diagnostics,
    decorations
  };
}

function buildDiagnostics(currentFile: ParsedFile, filesByUri: Map<string, ParsedFile>): vscode.Diagnostic[] {
  return [
    ...buildUnusedImportDiagnostics(currentFile, filesByUri),
    ...buildUnusedLocalVariableDiagnostics(currentFile.ast),
    ...buildUnusedPrivateFunctionDiagnostics(currentFile.ast)
  ];
}

export async function provideInlayHints(
  document: vscode.TextDocument,
  range: vscode.Range
): Promise<vscode.InlayHint[]> {
  if (!isSolidityDocument(document)) {
    return [];
  }

  const { currentFile, contractMap, allFiles } = await loadDocumentContext(document);
  if (!currentFile.ast) {
    return [];
  }

  const hints: vscode.InlayHint[] = [];
  const excludedRanges = findExcludedTextRanges(document, range);
  const constantMapCache = new Map<string, Map<string, StateVariableInfo>>();
  walk(currentFile.ast, (node) => {
    if (node.type === 'Identifier' && node.name && node.loc) {
      if (excludedRanges.some((excludedRange) => rangesIntersect(toDocumentRange(document, node), excludedRange))) {
        return;
      }

      const identifierPosition = new vscode.Position(node.loc.start.line - 1, node.loc.start.column);
      const currentContract = findActiveContract(currentFile.contracts, identifierPosition);
      if (!currentContract) {
        return;
      }

      let constantMap = constantMapCache.get(currentContract.name);
      if (!constantMap) {
        constantMap = buildConstantMap(currentContract, contractMap);
        constantMapCache.set(currentContract.name, constantMap);
      }

      const constantInfo = constantMap.get(node.name);
      if (!constantInfo?.constantValueText) {
        return;
      }

      if (
        constantInfo.uri.toString() === document.uri.toString() &&
        sameRange(node.range, constantInfo.nameRange)
      ) {
        return;
      }

      const hint = new vscode.InlayHint(
        toDocumentRange(document, node).end,
        `: ${constantInfo.constantValueText}`,
        vscode.InlayHintKind.Parameter
      );
      hints.push(hint);
      return;
    }

    if (node.type !== 'FunctionCall' || !node.loc) {
      return;
    }

    if (!rangesIntersect(toRange(node.loc), range)) {
      return;
    }

    if ((node.names?.length ?? 0) > 0 || (node.identifiers?.length ?? 0) > 0) {
      return;
    }

    const args = node.arguments ?? [];
    if (args.length === 0) {
      return;
    }

    const callPosition = new vscode.Position(node.loc.start.line - 1, node.loc.start.column);
    const currentContract = findActiveContract(currentFile.contracts, callPosition);
    if (!currentContract) {
      return;
    }

    const enclosingFunction = findEnclosingFunction(currentContract.functions, callPosition);
    const signature = resolveCallSignature(node.expression, args.length, currentContract, contractMap, enclosingFunction);
    const parameters = signature?.parameters ?? resolveStructConstruction(node.expression, args.length, currentContract, contractMap, allFiles)?.fields;
    if (!parameters) {
      return;
    }

    for (let index = 0; index < Math.min(parameters.length, args.length); index++) {
      const parameter = parameters[index];
      const argument = args[index];
      if (!parameter.name || !argument?.loc) {
        continue;
      }

      const hint = new vscode.InlayHint(
        new vscode.Position(argument.loc.start.line - 1, argument.loc.start.column),
        `${parameter.name}:`,
        vscode.InlayHintKind.Parameter
      );
      hint.paddingRight = true;
      hints.push(hint);
    }
  });

  return hints;
}

async function loadDocumentContext(document: vscode.TextDocument): Promise<{
  currentFile: ParsedFile;
  allFiles: ParsedFile[];
  contractMap: Map<string, ContractInfo>;
  filesByUri: Map<string, ParsedFile>;
}> {
  const cache = new Map<string, Promise<ParsedFile>>();
  const currentFile = await loadParsedFile(document.uri, cache, document.getText());
  const allFiles = await Promise.all(Array.from(cache.values()));
  const contractMap = new Map<string, ContractInfo>();
  for (const file of allFiles) {
    for (const contract of file.contracts) {
      if (!contractMap.has(contract.name)) {
        contractMap.set(contract.name, contract);
      }
    }
  }

  return {
    currentFile,
    allFiles,
    contractMap,
    filesByUri: new Map<string, ParsedFile>(allFiles.map((file) => [file.uri.toString(), file]))
  };
}

async function loadParsedFile(
  uri: vscode.Uri,
  cache: Map<string, Promise<ParsedFile>>,
  providedText?: string
): Promise<ParsedFile> {
  const key = uri.toString();
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const source = providedText ?? (await readDocumentText(uri));
    let ast: any;
    try {
      ast = parser.parse(source, { loc: true, range: true, tolerant: true });
    } catch {
      return {
        uri,
        ast: undefined,
        source,
        imports: [],
        contracts: [],
        topLevelStructs: [],
        topLevelNames: []
      };
    }

    const imports = extractImports(ast);
    const contracts = extractContracts(ast, uri, source);
    const topLevelStructs = extractTopLevelStructs(ast, uri);
    const topLevelNames = extractTopLevelNames(ast);
    const parsed: ParsedFile = { uri, ast, source, imports, contracts, topLevelStructs, topLevelNames };

    for (const entry of imports) {
      const resolvedUri = await resolveImportUri(uri, entry.path);
      entry.resolvedUri = resolvedUri;
      if (resolvedUri) {
        await loadParsedFile(resolvedUri, cache);
      }
    }

    return parsed;
  })();

  cache.set(key, promise);
  return promise;
}

async function readDocumentText(uri: vscode.Uri): Promise<string> {
  const openDocument = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());
  if (openDocument) {
    return openDocument.getText();
  }

  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}

function extractImports(ast: any): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (const child of ast?.children ?? []) {
    if (child?.type !== 'ImportDirective') {
      continue;
    }

    imports.push({
      path: child.path ?? child.pathLiteral ?? '',
      symbolAliases: normalizeImportAliases(child.symbolAliases),
      unitAlias: normalizeName(child.unitAlias),
      location: child.loc
    });
  }
  return imports;
}

function normalizeImportAliases(rawAliases: any[] = []): ImportAlias[] {
  return rawAliases
    .map((alias) => {
      const foreign = normalizeName(alias?.foreign ?? alias?.symbol ?? alias?.name ?? alias?.[0]);
      const local = normalizeName(alias?.local ?? alias?.alias ?? alias?.[1]) ?? foreign;
      if (!foreign || !local) {
        return undefined;
      }

      return {
        foreign,
        local,
        location: alias?.local?.loc ?? alias?.foreign?.loc ?? alias?.loc
      };
    })
    .filter(Boolean) as ImportAlias[];
}

function extractTopLevelNames(ast: any): string[] {
  const names = new Set<string>();
  for (const child of ast?.children ?? []) {
    const name = normalizeName(child?.name);
    if (!name) {
      continue;
    }
    if (['ContractDefinition', 'StructDefinition', 'EnumDefinition', 'UserDefinedValueTypeDefinition'].includes(child.type)) {
      names.add(name);
    }
  }
  return Array.from(names);
}

function extractTopLevelStructs(ast: any, uri: vscode.Uri): StructInfo[] {
  const structs: StructInfo[] = [];
  for (const child of ast?.children ?? []) {
    if (child?.type !== 'StructDefinition') {
      continue;
    }
    structs.push(toStructInfo(child, uri));
  }
  return structs;
}

function extractContracts(ast: any, uri: vscode.Uri, source: string): ContractInfo[] {
  const contracts: ContractInfo[] = [];
  for (const child of ast?.children ?? []) {
    if (child?.type !== 'ContractDefinition') {
      continue;
    }

    const contractName = normalizeName(child.name);
    if (!contractName) {
      continue;
    }

    const stateVariables: StateVariableInfo[] = [];
    const structs: StructInfo[] = [];
    const functions: FunctionInfo[] = [];
    const usingLibraries = new Set<string>();
    for (const subNode of child.subNodes ?? []) {
      if (subNode?.type === 'UsingForDeclaration') {
        const libraryName = lastNameSegment(normalizeName(subNode.libraryName));
        if (libraryName) {
          usingLibraries.add(libraryName);
        }
      }

      if (subNode?.type === 'StateVariableDeclaration') {
        for (const variable of subNode.variables ?? []) {
          const variableName = normalizeName(variable?.name);
          if (!variableName) {
            continue;
          }
          stateVariables.push({
            name: variableName,
            isConstant: Boolean(variable?.isDeclaredConst ?? variable?.isConstant ?? variable?.constant),
            isImmutable: Boolean(variable?.isImmutable ?? variable?.immutable),
            typeName: getNamedTypeName(variable?.typeName),
            uri,
            location: variable?.loc ?? subNode?.loc,
            nameRange: variable?.identifier?.range ?? variable?.range,
            constantValueText: getConstantValueText(source, variable),
            contractName
          });
        }
      }

      if (subNode?.type === 'StructDefinition') {
        structs.push({
          ...toStructInfo(subNode, uri),
          contractName
        });
      }

      if (subNode?.type === 'FunctionDefinition') {
        const label = formatFunctionLabel(subNode);
        const name = getFunctionName(subNode);
        const parameters = extractParameters(subNode);
        const variableTypes = collectVariableTypes(subNode, parameters);
        const localNames = collectLocalNames(subNode);
        functions.push({
          id: `${contractName}:${label}`,
          name,
          label,
          parameters,
          variableTypes,
          visibility: subNode.visibility ?? (name === 'receive' || name === 'fallback' ? 'external' : 'internal'),
          stateMutability: subNode.stateMutability ?? 'nonpayable',
          hasBody: Boolean(subNode.body),
          contractName,
          uri,
          location: subNode.loc,
          directModifies: collectDirectModifications(subNode.body, localNames),
          calls: collectCalledFunctions(subNode.body, localNames)
        });
      }
    }

    contracts.push({
      name: contractName,
      kind: child.kind ?? 'contract',
      uri,
      location: child.loc,
      baseNames: (child.baseContracts ?? []).map(getBaseContractName).filter(Boolean),
      usingLibraries: Array.from(usingLibraries),
      stateVariables,
      structs,
      functions
    });
  }

  return contracts;
}

function extractParameters(fn: any): ParameterInfo[] {
  return getParameterArray(fn?.parameters).map((parameter: any) => ({
    name: normalizeName(parameter?.name),
    typeName: getNamedTypeName(parameter?.typeName)
  }));
}

function toStructInfo(node: any, uri: vscode.Uri): StructInfo {
  return {
    name: normalizeName(node?.name) ?? 'Struct',
    fields: (node?.members ?? []).map((member: any) => ({
      name: normalizeName(member?.name)
    })),
    uri,
    location: node?.loc
  };
}

function getConstantValueText(source: string, variable: any): string | undefined {
  const expression = variable?.expression;
  if (!expression || !Array.isArray(expression.range)) {
    return undefined;
  }

  return source.slice(expression.range[0], expression.range[1] + 1).trim();
}

function collectVariableTypes(fn: any, parameters: ParameterInfo[]): Map<string, string> {
  const variableTypes = new Map<string, string>();

  for (const parameter of parameters) {
    if (parameter.name && parameter.typeName) {
      variableTypes.set(parameter.name, parameter.typeName);
    }
  }

  walk(fn?.body, (node) => {
    if (node.type === 'VariableDeclarationStatement') {
      for (const variable of node.variables ?? []) {
        const name = normalizeName(variable?.name);
        const typeName = getNamedTypeName(variable?.typeName);
        if (name && typeName) {
          variableTypes.set(name, typeName);
        }
      }
      return;
    }

    if (node.type === 'CatchClause') {
      for (const parameter of getParameterArray(node.parameters)) {
        const name = normalizeName(parameter?.name);
        const typeName = getNamedTypeName(parameter?.typeName);
        if (name && typeName) {
          variableTypes.set(name, typeName);
        }
      }
    }
  });

  return variableTypes;
}

function getBaseContractName(baseContract: any): string | undefined {
  const baseName = baseContract?.baseName;
  if (!baseName) {
    return undefined;
  }

  return lastNameSegment(
    normalizeName(baseName?.namePath) ??
      normalizeName(baseName?.name) ??
      normalizeName(baseName?.path) ??
      normalizeName(baseName?.identifier)
  );
}

function buildPublicFunctionList(currentContract: ContractInfo, lineage: ContractInfo[]): Array<FunctionInfo & { inherited: boolean }> {
  const items: Array<FunctionInfo & { inherited: boolean }> = [];
  for (const contract of lineage) {
    const inherited = contract.name !== currentContract.name;
    for (const fn of contract.functions) {
      if (!isPublicStateChangingFunction(fn)) {
        continue;
      }
      items.push({ ...fn, inherited });
    }
  }
  return items;
}

function isPublicStateChangingFunction(fn: FunctionInfo): boolean {
  if (!fn.hasBody) {
    return false;
  }
  if (!['public', 'external'].includes(fn.visibility)) {
    return false;
  }
  if (['view', 'pure'].includes(fn.stateMutability)) {
    return false;
  }
  return fn.name !== 'constructor';
}

function buildVariableList(
  currentContract: ContractInfo,
  lineage: ContractInfo[],
  cockpitItems: FunctionSummary[],
  publicFunctions: Array<FunctionInfo & { inherited: boolean }>,
  transitiveModifies: Map<string, Set<string>>
): VariableSummary[] {
  const seen = new Set<string>();
  const variables: VariableSummary[] = [];

  for (const contract of lineage) {
    const inherited = contract.name !== currentContract.name;
    for (const variable of contract.stateVariables) {
      if (variable.isConstant || variable.isImmutable) {
        continue;
      }
      if (seen.has(variable.name)) {
        continue;
      }
      seen.add(variable.name);

      const modifiedBy = publicFunctions
        .filter((fn) => (transitiveModifies.get(fn.id) ?? new Set<string>()).has(variable.name))
        .map((fn) => {
          const summary = cockpitItems.find((item) => item.label === fn.label && item.contractName === fn.contractName);
          return summary ?? {
            name: fn.name,
            label: fn.label,
            detail: `${fn.contractName}${fn.inherited ? ' (inherited)' : ''}`,
            contractName: fn.contractName,
            inherited: fn.inherited,
            location: toLocation(fn.uri, fn.location)
          };
        });

      variables.push({
        name: variable.name,
        detail: `${contract.name}${inherited ? ' (inherited)' : ''}`,
        inherited,
        isConstant: variable.isConstant,
        isImmutable: variable.isImmutable,
        location: toLocation(variable.uri, variable.location),
        modifiedBy
      });
    }
  }

  return variables;
}

function buildConstantMap(currentContract: ContractInfo, contractsByName: Map<string, ContractInfo>): Map<string, StateVariableInfo> {
  const constants = new Map<string, StateVariableInfo>();
  for (const contract of resolveLineage(currentContract, contractsByName)) {
    for (const variable of contract.stateVariables) {
      if (!variable.isConstant || !variable.constantValueText || constants.has(variable.name)) {
        continue;
      }
      constants.set(variable.name, variable);
    }
  }
  return constants;
}

function buildTransitiveModificationMap(lineage: ContractInfo[]): Map<string, Set<string>> {
  const byName = new Map<string, FunctionInfo[]>();
  const allFunctions = lineage.flatMap((contract) => contract.functions);
  for (const fn of allFunctions) {
    if (!byName.has(fn.name)) {
      byName.set(fn.name, []);
    }
    byName.get(fn.name)?.push(fn);
  }

  const memo = new Map<string, Set<string>>();
  const visit = (fn: FunctionInfo, stack: Set<string>): Set<string> => {
    const cached = memo.get(fn.id);
    if (cached) {
      return cached;
    }

    if (stack.has(fn.id)) {
      return new Set(fn.directModifies);
    }

    stack.add(fn.id);
    const modified = new Set(fn.directModifies);
    for (const calledName of fn.calls) {
      for (const callee of byName.get(calledName) ?? []) {
        for (const variableName of visit(callee, stack)) {
          modified.add(variableName);
        }
      }
    }
    stack.delete(fn.id);
    memo.set(fn.id, modified);
    return modified;
  };

  for (const fn of allFunctions) {
    visit(fn, new Set<string>());
  }

  return memo;
}

function collectLocalNames(fn: any): Set<string> {
  const names = new Set<string>();
  for (const parameter of getParameterArray(fn?.parameters)) {
    const name = normalizeName(parameter?.name);
    if (name) {
      names.add(name);
    }
  }
  for (const parameter of getParameterArray(fn?.returnParameters)) {
    const name = normalizeName(parameter?.name);
    if (name) {
      names.add(name);
    }
  }

  walk(fn?.body, (node) => {
    if (node.type === 'VariableDeclarationStatement') {
      for (const variable of node.variables ?? []) {
        const name = normalizeName(variable?.name);
        if (name) {
          names.add(name);
        }
      }
    }

    if (node.type === 'CatchClause') {
      for (const parameter of getParameterArray(node.parameters)) {
        const name = normalizeName(parameter?.name);
        if (name) {
          names.add(name);
        }
      }
    }
  });

  return names;
}

function collectDirectModifications(body: any, localNames: Set<string>): Set<string> {
  const modified = new Set<string>();

  walk(body, (node) => {
    if (node.type === 'Assignment' || isAssignmentLikeBinaryOperation(node)) {
      for (const name of extractRootIdentifiers(node.left ?? node.leftHandSide)) {
        if (!localNames.has(name)) {
          modified.add(name);
        }
      }
    }

    if (node.type === 'UnaryOperation' && ['++', '--', 'delete'].includes(node.operator)) {
      for (const name of extractRootIdentifiers(node.subExpression)) {
        if (!localNames.has(name)) {
          modified.add(name);
        }
      }
    }

    if (node.type === 'FunctionCall') {
      const expression = node.expression;
      if (expression?.type === 'MemberAccess' && ['push', 'pop'].includes(expression.memberName)) {
        for (const name of extractRootIdentifiers(expression.expression)) {
          if (!localNames.has(name)) {
            modified.add(name);
          }
        }
      }
    }
  });

  return modified;
}

function isAssignmentLikeBinaryOperation(node: any): boolean {
  return node?.type === 'BinaryOperation' && ASSIGNMENT_OPERATORS.has(node.operator);
}

const ASSIGNMENT_OPERATORS = new Set([
  '=',
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '|=',
  '&=',
  '^=',
  '<<=',
  '>>='
]);

function collectCalledFunctions(body: any, localNames: Set<string>): Set<string> {
  const calls = new Set<string>();

  walk(body, (node) => {
    if (node.type !== 'FunctionCall') {
      return;
    }

    const expression = node.expression;
    if (expression?.type === 'Identifier' && !localNames.has(expression.name)) {
      calls.add(expression.name);
    }

    if (
      expression?.type === 'MemberAccess' &&
      expression.expression?.type === 'Identifier' &&
      ['this', 'super'].includes(expression.expression.name)
    ) {
      calls.add(expression.memberName);
    }
  });

  return calls;
}

function extractRootIdentifiers(node: any): string[] {
  if (!node) {
    return [];
  }

  if (Array.isArray(node)) {
    return node.flatMap((value) => extractRootIdentifiers(value));
  }

  switch (node.type) {
    case 'Identifier':
      return node.name ? [node.name] : [];
    case 'MemberAccess':
      return extractRootIdentifiers(node.expression);
    case 'IndexAccess':
    case 'IndexRangeAccess':
      return extractRootIdentifiers(node.base);
    case 'TupleExpression':
      return (node.components ?? []).flatMap((value: any) => extractRootIdentifiers(value));
    case 'FunctionCall':
      return extractRootIdentifiers(node.expression);
    case 'UnaryOperation':
      return extractRootIdentifiers(node.subExpression);
    default:
      return [];
  }
}

function buildUnusedImportDiagnostics(
  currentFile: ParsedFile,
  filesByUri: Map<string, ParsedFile>
): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];
  const usedSymbols = collectUsedSymbols(currentFile.ast);

  for (const imported of currentFile.imports) {
    if (imported.symbolAliases.length > 0) {
      for (const alias of imported.symbolAliases) {
        if (usedSymbols.has(alias.local)) {
          continue;
        }
        diagnostics.push(
          new vscode.Diagnostic(
            toRange(alias.location ?? imported.location),
            `Unused import "${alias.local}" from ${imported.path}`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      continue;
    }

    if (imported.unitAlias) {
      if (!usedSymbols.has(imported.unitAlias)) {
        diagnostics.push(
          new vscode.Diagnostic(
            toRange(imported.location),
            `Unused import alias "${imported.unitAlias}"`,
            vscode.DiagnosticSeverity.Warning
          )
        );
      }
      continue;
    }

    const resolved = imported.resolvedUri ? filesByUri.get(imported.resolvedUri.toString()) : undefined;
    if (!resolved) {
      continue;
    }

    const exportedNames = resolved.topLevelNames;
    if (!exportedNames || exportedNames.length === 0) {
      continue;
    }

    const anyUsed = exportedNames.some((name) => usedSymbols.has(name));
    if (!anyUsed) {
      diagnostics.push(
        new vscode.Diagnostic(
          toRange(imported.location),
          `Unused import ${imported.path}`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }
  }

  return diagnostics;
}

function buildUnusedLocalVariableDiagnostics(ast: any): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  walk(ast, (node) => {
    if (!isExecutableDefinition(node) || !node.body) {
      return;
    }

    const declarations = collectLocalVariableDeclarations(node.body);
    if (declarations.length === 0) {
      return false;
    }

    const uniqueDeclarations = new Map<string, LocalDeclarationInfo>();
    const duplicateNames = new Set<string>();
    for (const declaration of declarations) {
      if (uniqueDeclarations.has(declaration.name)) {
        duplicateNames.add(declaration.name);
        uniqueDeclarations.delete(declaration.name);
        continue;
      }
      if (!duplicateNames.has(declaration.name)) {
        uniqueDeclarations.set(declaration.name, declaration);
      }
    }

    if (uniqueDeclarations.size === 0) {
      return false;
    }

    const readCounts = collectReadCounts(node.body, new Set(uniqueDeclarations.keys()));
    for (const declaration of uniqueDeclarations.values()) {
      if ((readCounts.get(declaration.name) ?? 0) > 0) {
        continue;
      }
      diagnostics.push(
        new vscode.Diagnostic(
          declaration.range,
          `Unused local variable "${declaration.name}"`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }

    return false;
  });

  return diagnostics;
}

function buildUnusedPrivateFunctionDiagnostics(ast: any): vscode.Diagnostic[] {
  const diagnostics: vscode.Diagnostic[] = [];

  for (const contract of ast?.children ?? []) {
    if (contract?.type !== 'ContractDefinition') {
      continue;
    }

    const allFunctions = (contract.subNodes ?? []).filter((subNode: any) => subNode?.type === 'FunctionDefinition');
    const keyCounts = new Map<string, number>();
    for (const fn of allFunctions) {
      const key = buildFunctionArityKey(getFunctionName(fn), getParameterArray(fn?.parameters).length);
      keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }

    const privateFunctions = allFunctions
      .filter((fn: any) => fn.visibility === 'private' && fn.body)
      .map((fn: any) => ({
        name: getFunctionName(fn),
        key: buildFunctionArityKey(getFunctionName(fn), getParameterArray(fn?.parameters).length),
        label: formatFunctionLabel(fn),
        range: toRange(fn.loc)
      }))
      .filter((fn: any) => !['constructor', 'fallback', 'receive'].includes(fn.name));

    if (privateFunctions.length === 0) {
      continue;
    }

    const calledKeys = collectCalledFunctionKeys(contract);
    for (const fn of privateFunctions) {
      if ((keyCounts.get(fn.key) ?? 0) !== 1) {
        continue;
      }
      if (calledKeys.has(fn.key)) {
        continue;
      }
      diagnostics.push(
        new vscode.Diagnostic(
          fn.range,
          `Unused private function "${fn.label}"`,
          vscode.DiagnosticSeverity.Warning
        )
      );
    }
  }

  return diagnostics;
}

interface LocalDeclarationInfo {
  name: string;
  range: vscode.Range;
}

function collectLocalVariableDeclarations(body: any): LocalDeclarationInfo[] {
  const declarations: LocalDeclarationInfo[] = [];

  walk(body, (node) => {
    if (node.type !== 'VariableDeclarationStatement') {
      return;
    }

    for (const variable of node.variables ?? []) {
      const name = normalizeName(variable?.name);
      if (!name) {
        continue;
      }
      declarations.push({
        name,
        range: toRange(variable?.loc ?? node.loc)
      });
    }
  });

  return declarations;
}

function collectReadCounts(body: any, localNames: Set<string>): Map<string, number> {
  const readCounts = new Map<string, number>();

  walk(body, (node, parent) => {
    if (node.type !== 'Identifier' || !localNames.has(node.name) || !isReadReference(node, parent)) {
      return;
    }
    readCounts.set(node.name, (readCounts.get(node.name) ?? 0) + 1);
  });

  return readCounts;
}

function isReadReference(node: any, parent?: any): boolean {
  if (!parent) {
    return true;
  }

  const leftHandSide = parent.left ?? parent.leftHandSide;
  if ((parent.type === 'Assignment' || isAssignmentLikeBinaryOperation(parent)) && leftHandSide === node) {
    return parent.operator !== '=';
  }

  if (parent.type === 'UnaryOperation' && parent.subExpression === node) {
    return parent.operator !== 'delete';
  }

  return true;
}

function collectCalledFunctionKeys(contract: any): Set<string> {
  const called = new Set<string>();

  for (const subNode of contract?.subNodes ?? []) {
    if (!isExecutableDefinition(subNode) || !subNode.body) {
      continue;
    }

    const ownerKey =
      subNode.type === 'FunctionDefinition'
        ? buildFunctionArityKey(getFunctionName(subNode), getParameterArray(subNode?.parameters).length)
        : undefined;

    walk(subNode.body, (node) => {
      if (node.type !== 'FunctionCall' || node.expression?.type !== 'Identifier') {
        return;
      }

      const calledKey = buildFunctionArityKey(node.expression.name, (node.arguments ?? []).length);
      if (calledKey !== ownerKey) {
        called.add(calledKey);
      }
    });
  }

  return called;
}

function buildFunctionArityKey(name: string, arity: number): string {
  return `${name}/${arity}`;
}

function isExecutableDefinition(node: any): boolean {
  return node?.type === 'FunctionDefinition' || node?.type === 'ModifierDefinition';
}

function collectUsedSymbols(ast: any): Set<string> {
  const names = new Set<string>();

  walk(ast, (node, parent) => {
    if (node.type === 'ImportDirective') {
      return false;
    }

    if (node.type === 'Identifier') {
      if (node.name) {
        names.add(node.name);
      }
      return;
    }

    if (node.type === 'UserDefinedTypeName') {
      const typeName = lastNameSegment(node.namePath ?? node.name);
      if (typeName) {
        names.add(typeName);
      }
      return;
    }

    if (node.type === 'InheritanceSpecifier') {
      const typeName = getBaseContractName(node);
      if (typeName) {
        names.add(typeName);
      }
      return;
    }

    if (node.type === 'UsingForDeclaration') {
      const libraryName = lastNameSegment(normalizeName(node.libraryName));
      if (libraryName) {
        names.add(libraryName);
      }

      const typeName = lastNameSegment(normalizeName(node.typeName?.namePath) ?? normalizeName(node.typeName?.name));
      if (typeName) {
        names.add(typeName);
      }
      return;
    }

    if (typeof node.namePath === 'string' && parent?.type !== 'ImportDirective') {
      const typeName = lastNameSegment(node.namePath);
      if (typeName) {
        names.add(typeName);
      }
    }
  });

  return names;
}

function buildSemanticDecorations(
  document: vscode.TextDocument,
  currentContract: ContractInfo,
  lineage: ContractInfo[]
): { immutable: vscode.Range[]; constant: vscode.Range[]; mutable: vscode.Range[] } {
  if (!currentContract.location) {
    return { immutable: [], constant: [], mutable: [] };
  }

  const contractRange = toRange(currentContract.location);
  const excludedRanges = findExcludedTextRanges(document, contractRange);
  const immutableNames = new Set<string>();
  const constantNames = new Set<string>();
  const mutableNames = new Set<string>();

  for (const variable of currentContract.stateVariables) {
    if (variable.isConstant) {
      constantNames.add(variable.name);
      continue;
    }
    if (variable.isImmutable) {
      immutableNames.add(variable.name);
      continue;
    }
    mutableNames.add(variable.name);
  }

  for (const contract of lineage) {
    if (contract.name === currentContract.name) {
      continue;
    }
    for (const variable of contract.stateVariables) {
      if (variable.isConstant) {
        constantNames.add(variable.name);
        continue;
      }
      if (variable.isImmutable) {
        immutableNames.add(variable.name);
        continue;
      }
      mutableNames.add(variable.name);
    }
  }

  return {
    immutable: findWordRanges(document, contractRange, immutableNames, excludedRanges),
    constant: findWordRanges(document, contractRange, constantNames, excludedRanges),
    mutable: findWordRanges(document, contractRange, mutableNames, excludedRanges)
  };
}

function findWordRanges(
  document: vscode.TextDocument,
  range: vscode.Range,
  names: Set<string>,
  excludedRanges: vscode.Range[]
): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  if (names.size === 0) {
    return ranges;
  }

  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const text = document.getText().slice(startOffset, endOffset);

  for (const name of names) {
    const matcher = new RegExp(`\\b${escapeRegExp(name)}\\b`, 'g');
    let match: RegExpExecArray | null = matcher.exec(text);
    while (match) {
      const matchStart = document.positionAt(startOffset + match.index);
      const matchEnd = document.positionAt(startOffset + match.index + match[0].length);
      const matchRange = new vscode.Range(matchStart, matchEnd);
      if (!excludedRanges.some((excludedRange) => rangesIntersect(matchRange, excludedRange))) {
        ranges.push(matchRange);
      }
      match = matcher.exec(text);
    }
  }

  return ranges;
}

function rangesIntersect(left: vscode.Range, right: vscode.Range): boolean {
  return left.intersection(right) !== undefined;
}

function findExcludedTextRanges(document: vscode.TextDocument, range: vscode.Range): vscode.Range[] {
  const ranges: vscode.Range[] = [];
  const startOffset = document.offsetAt(range.start);
  const endOffset = document.offsetAt(range.end);
  const text = document.getText().slice(startOffset, endOffset);

  let index = 0;
  while (index < text.length) {
    const current = text[index];
    const next = text[index + 1];

    if (current === '/' && next === '/') {
      const commentStart = index;
      index += 2;
      while (index < text.length && text[index] !== '\n') {
        index++;
      }
      ranges.push(toOffsetRange(document, startOffset + commentStart, startOffset + index));
      continue;
    }

    if (current === '/' && next === '*') {
      const commentStart = index;
      index += 2;
      while (index < text.length && !(text[index] === '*' && text[index + 1] === '/')) {
        index++;
      }
      index = Math.min(index + 2, text.length);
      ranges.push(toOffsetRange(document, startOffset + commentStart, startOffset + index));
      continue;
    }

    if (current === '"' || current === '\'') {
      const quote = current;
      const stringStart = index;
      index++;
      while (index < text.length) {
        if (text[index] === '\\') {
          index += 2;
          continue;
        }
        if (text[index] === quote) {
          index++;
          break;
        }
        index++;
      }
      ranges.push(toOffsetRange(document, startOffset + stringStart, startOffset + Math.min(index, text.length)));
      continue;
    }

    index++;
  }

  return ranges;
}

function toOffsetRange(document: vscode.TextDocument, startOffset: number, endOffset: number): vscode.Range {
  return new vscode.Range(document.positionAt(startOffset), document.positionAt(endOffset));
}

function toDocumentRange(document: vscode.TextDocument, node: any): vscode.Range {
  if (Array.isArray(node?.range)) {
    return toOffsetRange(document, node.range[0], node.range[1] + 1);
  }
  return toRange(node?.loc);
}

function sameRange(left?: number[], right?: number[]): boolean {
  return Array.isArray(left) && Array.isArray(right) && left[0] === right[0] && left[1] === right[1];
}

function resolveLineage(contract: ContractInfo, contractsByName: Map<string, ContractInfo>): ContractInfo[] {
  const visited = new Set<string>();
  const ordered: ContractInfo[] = [];

  const visit = (entry: ContractInfo) => {
    if (visited.has(entry.name)) {
      return;
    }
    visited.add(entry.name);
    ordered.push(entry);
    for (const baseName of entry.baseNames) {
      const base = contractsByName.get(baseName);
      if (base) {
        visit(base);
      }
    }
  };

  visit(contract);
  return ordered;
}

function resolveCallSignature(
  expression: any,
  argCount: number,
  currentContract: ContractInfo,
  contractsByName: Map<string, ContractInfo>,
  enclosingFunction?: FunctionInfo
): FunctionInfo | undefined {
  const lineage = resolveLineage(currentContract, contractsByName);

  if (expression?.type === 'Identifier') {
    return selectSingleSignature(findFunctionsByNameAndArity(lineage, expression.name, argCount));
  }

  if (expression?.type !== 'MemberAccess') {
    return undefined;
  }

  const memberName = expression.memberName;
  const baseName = expression.expression?.type === 'Identifier' ? expression.expression.name : undefined;

  if (baseName === 'this' || baseName === 'super') {
    return selectSingleSignature(findFunctionsByNameAndArity(lineage, memberName, argCount));
  }

  if (baseName && contractsByName.has(baseName)) {
    return selectSingleSignature(findFunctionsByNameAndArity(resolveLineage(contractsByName.get(baseName)!, contractsByName), memberName, argCount));
  }

  const receiverType = inferReceiverType(baseName, currentContract, contractsByName, enclosingFunction);
  if (receiverType && contractsByName.has(receiverType)) {
    return selectSingleSignature(findFunctionsByNameAndArity(resolveLineage(contractsByName.get(receiverType)!, contractsByName), memberName, argCount));
  }

  const usingLibraries = new Set(lineage.flatMap((contract) => contract.usingLibraries));
  const libraryMatches: FunctionInfo[] = [];
  for (const libraryName of usingLibraries) {
    const libraryContract = contractsByName.get(libraryName);
    if (!libraryContract) {
      continue;
    }

    for (const fn of libraryContract.functions) {
      if (fn.name === memberName && fn.parameters.length === argCount + 1) {
        libraryMatches.push({
          ...fn,
          parameters: fn.parameters.slice(1)
        });
      }
    }
  }

  return selectSingleSignature(libraryMatches);
}

function inferReceiverType(
  baseName: string | undefined,
  currentContract: ContractInfo,
  contractsByName: Map<string, ContractInfo>,
  enclosingFunction?: FunctionInfo
): string | undefined {
  if (!baseName) {
    return undefined;
  }

  const localType = enclosingFunction?.variableTypes.get(baseName);
  if (localType) {
    return localType;
  }

  for (const contract of resolveLineage(currentContract, contractsByName)) {
    const stateVariable = contract.stateVariables.find((variable) => variable.name === baseName && variable.typeName);
    if (stateVariable?.typeName) {
      return stateVariable.typeName;
    }
  }

  return undefined;
}

function resolveStructConstruction(
  expression: any,
  argCount: number,
  currentContract: ContractInfo,
  contractsByName: Map<string, ContractInfo>,
  allFiles: ParsedFile[]
): StructInfo | undefined {
  if (expression?.type !== 'Identifier') {
    return undefined;
  }

  const structName = expression.name;
  const lineage = resolveLineage(currentContract, contractsByName);
  const matches: StructInfo[] = [];

  for (const contract of lineage) {
    for (const structInfo of contract.structs) {
      if (structInfo.name === structName && structInfo.fields.length === argCount) {
        matches.push(structInfo);
      }
    }
  }

  for (const file of allFiles) {
    for (const structInfo of file.topLevelStructs) {
      if (structInfo.name === structName && structInfo.fields.length === argCount) {
        matches.push(structInfo);
      }
    }
  }

  if (matches.length !== 1) {
    return undefined;
  }
  return matches[0];
}

function findFunctionsByNameAndArity(contracts: ContractInfo[], name: string, argCount: number): FunctionInfo[] {
  const matches: FunctionInfo[] = [];
  for (const contract of contracts) {
    for (const fn of contract.functions) {
      if (fn.name === name && fn.parameters.length === argCount) {
        matches.push(fn);
      }
    }
  }
  return matches;
}

function selectSingleSignature(matches: FunctionInfo[]): FunctionInfo | undefined {
  if (matches.length !== 1) {
    return undefined;
  }
  return matches[0];
}

function findActiveContract(contracts: ContractInfo[], position: vscode.Position): ContractInfo | undefined {
  return contracts.find((contract) => locationContains(contract.location, position));
}

function findEnclosingFunction(functions: FunctionInfo[], position: vscode.Position): FunctionInfo | undefined {
  return functions.find((fn) => locationContains(fn.location, position));
}

function locationContains(location: SourceLocation | undefined, position: vscode.Position): boolean {
  if (!location) {
    return false;
  }

  const start = new vscode.Position(location.start.line - 1, location.start.column);
  const end = new vscode.Position(location.end.line - 1, location.end.column);
  return position.isAfterOrEqual(start) && position.isBeforeOrEqual(end);
}

function getFunctionName(fn: any): string {
  if (fn?.isConstructor || fn?.kind === 'constructor') {
    return 'constructor';
  }
  if (fn?.isReceiveEther || fn?.kind === 'receive') {
    return 'receive';
  }
  if (fn?.isFallback || fn?.kind === 'fallback') {
    return 'fallback';
  }
  return normalizeName(fn?.name) ?? 'anonymous';
}

function formatFunctionLabel(fn: any): string {
  const name = getFunctionName(fn);
  if (name === 'constructor') {
    return 'constructor';
  }

  const parameters = getParameterArray(fn?.parameters)
    .map((parameter: any) => formatTypeName(parameter?.typeName))
    .filter(Boolean)
    .join(', ');

  return `${name}(${parameters})`;
}

function getParameterArray(value: any): any[] {
  if (!value) {
    return [];
  }
  if (Array.isArray(value)) {
    return value;
  }
  if (Array.isArray(value.parameters)) {
    return value.parameters;
  }
  return [];
}

function formatTypeName(typeName: any): string {
  if (!typeName) {
    return '?';
  }

  switch (typeName.type) {
    case 'ElementaryTypeName':
      return typeName.name ?? '?';
    case 'UserDefinedTypeName':
      return lastNameSegment(typeName.namePath ?? typeName.name) ?? '?';
    case 'ArrayTypeName':
      return `${formatTypeName(typeName.baseTypeName)}[]`;
    case 'Mapping':
      return `mapping(${formatTypeName(typeName.keyType)} => ${formatTypeName(typeName.valueType)})`;
    case 'FunctionTypeName':
      return 'function';
    default:
      return typeName.name ?? typeName.type ?? '?';
  }
}

function getNamedTypeName(typeName: any): string | undefined {
  if (!typeName) {
    return undefined;
  }

  switch (typeName.type) {
    case 'UserDefinedTypeName':
      return lastNameSegment(typeName.namePath ?? typeName.name);
    case 'ElementaryTypeName':
      return typeName.name ?? undefined;
    case 'ArrayTypeName':
      return getNamedTypeName(typeName.baseTypeName);
    default:
      return undefined;
  }
}

function walk(node: any, visitor: (node: any, parent?: any) => void | boolean, parent?: any): void {
  if (!node) {
    return;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      walk(item, visitor, parent);
    }
    return;
  }

  if (typeof node !== 'object') {
    return;
  }

  if (typeof node.type === 'string') {
    const result = visitor(node, parent);
    if (result === false) {
      return;
    }
  }

  for (const [key, value] of Object.entries(node)) {
    if (key === 'loc' || key === 'range') {
      continue;
    }
    if (!value || typeof value !== 'object') {
      continue;
    }
    walk(value, visitor, node);
  }
}

async function resolveImportUri(baseUri: vscode.Uri, importPath: string): Promise<vscode.Uri | undefined> {
  if (!importPath || importPath.startsWith('http://') || importPath.startsWith('https://')) {
    return undefined;
  }

  const candidates: vscode.Uri[] = [];
  if (importPath.startsWith('.')) {
    candidates.push(vscode.Uri.file(path.resolve(path.dirname(baseUri.fsPath), importPath)));
  } else {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidates.push(vscode.Uri.file(path.join(folder.uri.fsPath, importPath)));
      for (const remapping of await loadRemappingsForFolder(folder.uri.fsPath)) {
        const remapped = applyRemapping(importPath, remapping);
        if (remapped) {
          candidates.push(vscode.Uri.file(path.resolve(folder.uri.fsPath, remapped)));
        }
      }
    }
  }

  for (const candidate of candidates) {
    try {
      const stat = await vscode.workspace.fs.stat(candidate);
      if (stat.type === vscode.FileType.File) {
        return candidate;
      }
    } catch {
      // Ignore unresolved imports.
    }
  }

  return undefined;
}

interface ImportRemapping {
  from: string;
  to: string;
}

const remappingsCache = new Map<string, Promise<ImportRemapping[]>>();

async function loadRemappingsForFolder(folderPath: string): Promise<ImportRemapping[]> {
  const cached = remappingsCache.get(folderPath);
  if (cached) {
    return cached;
  }

  const promise = (async () => {
    const remappings: ImportRemapping[] = [];

    const foundryToml = path.join(folderPath, 'foundry.toml');
    remappings.push(...(await readFoundryRemappings(foundryToml)));

    const remappingsTxt = path.join(folderPath, 'remappings.txt');
    remappings.push(...(await readRemappingsTxt(remappingsTxt)));

    return remappings;
  })();

  remappingsCache.set(folderPath, promise);
  return promise;
}

async function readFoundryRemappings(foundryTomlPath: string): Promise<ImportRemapping[]> {
  try {
    const text = await vscode.workspace.fs.readFile(vscode.Uri.file(foundryTomlPath));
    const content = Buffer.from(text).toString('utf8');
    const match = content.match(/remappings\s*=\s*\[([\s\S]*?)\]/m);
    if (!match) {
      return [];
    }

    return Array.from(match[1].matchAll(/"([^"]+)"/g))
      .map((entry) => parseRemappingEntry(entry[1]))
      .filter(Boolean) as ImportRemapping[];
  } catch {
    return [];
  }
}

async function readRemappingsTxt(remappingsTxtPath: string): Promise<ImportRemapping[]> {
  try {
    const text = await vscode.workspace.fs.readFile(vscode.Uri.file(remappingsTxtPath));
    return Buffer.from(text)
      .toString('utf8')
      .split(/\r?\n/)
      .map((line) => parseRemappingEntry(line.trim()))
      .filter(Boolean) as ImportRemapping[];
  } catch {
    return [];
  }
}

function parseRemappingEntry(value: string): ImportRemapping | undefined {
  const clean = value.trim();
  if (!clean || clean.startsWith('#')) {
    return undefined;
  }

  const separator = clean.indexOf('=');
  if (separator === -1) {
    return undefined;
  }

  const from = clean.slice(0, separator).trim().replace(/\/+$/, '');
  const to = clean.slice(separator + 1).trim().replace(/\/+$/, '');
  if (!from || !to) {
    return undefined;
  }

  return { from, to };
}

function applyRemapping(importPath: string, remapping: ImportRemapping): string | undefined {
  if (importPath === remapping.from) {
    return remapping.to;
  }

  if (!importPath.startsWith(`${remapping.from}/`)) {
    return undefined;
  }

  return path.join(remapping.to, importPath.slice(remapping.from.length + 1));
}

function toLocation(uri: vscode.Uri, location?: SourceLocation): vscode.Location | undefined {
  return location ? new vscode.Location(uri, toRange(location)) : undefined;
}

function toRange(location?: SourceLocation): vscode.Range {
  if (!location) {
    return new vscode.Range(0, 0, 0, 0);
  }
  return new vscode.Range(
    new vscode.Position(location.start.line - 1, location.start.column),
    new vscode.Position(location.end.line - 1, location.end.column)
  );
}

function normalizeName(value: any): string | undefined {
  if (!value) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value?.name === 'string') {
    return value.name;
  }
  if (typeof value?.namePath === 'string') {
    return value.namePath;
  }
  if (typeof value?.identifier === 'string') {
    return value.identifier;
  }
  return undefined;
}

function lastNameSegment(value?: string): string | undefined {
  if (!value) {
    return undefined;
  }
  const parts = value.split('.');
  return parts[parts.length - 1];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

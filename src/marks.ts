import * as path from 'node:path';
import * as vscode from 'vscode';
import { analyzeActiveContract, isSolidityDocument } from './solidity';
import { PersistentStateManager } from './state';

type MarkedFilterMode = 'all' | 'entrypoints';

export interface MarkedEntry {
  kind: 'file' | 'folder';
  source: 'manual' | 'scope';
  key: string;
  uri: vscode.Uri;
}

export class MarkManager implements vscode.TreeDataProvider<MarkedEntry>, vscode.FileDecorationProvider, vscode.Disposable {
  private readonly treeEmitter = new vscode.EventEmitter<any>();
  private readonly decorationEmitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  private readonly scopeWatcher: vscode.FileSystemWatcher;
  private readonly entryPointProgressCache = new Map<string, { audited: number; total: number }>();

  private manualFiles = new Set<string>();
  private excludedFiles = new Set<string>();
  private scopeFiles = new Set<string>();
  private filterMode: MarkedFilterMode = 'all';

  readonly onDidChangeTreeData = this.treeEmitter.event;
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly stateManager: PersistentStateManager
  ) {
    this.scopeWatcher = vscode.workspace.createFileSystemWatcher('**/SCOPE.md');
    this.scopeWatcher.onDidChange(() => void this.reloadScopeMarks(), this, context.subscriptions);
    this.scopeWatcher.onDidCreate(() => void this.reloadScopeMarks(), this, context.subscriptions);
    this.scopeWatcher.onDidDelete(() => void this.reloadScopeMarks(), this, context.subscriptions);
  }

  async initialize(): Promise<void> {
    const markedState = this.stateManager.getMarkedState();
    this.manualFiles = new Set(markedState.manualFiles);
    this.excludedFiles = new Set(markedState.excludedFiles);
    this.filterMode = markedState.filterMode as MarkedFilterMode;
    await this.migrateLegacyFolderMarks(
      new Set(markedState.legacyManualFolders),
      new Set(markedState.legacyExcludedFolders)
    );
    await this.reloadScopeMarks();
  }

  dispose(): void {
    this.scopeWatcher.dispose();
    this.treeEmitter.dispose();
    this.decorationEmitter.dispose();
  }

  async getTreeItem(entry: MarkedEntry): Promise<vscode.TreeItem> {
    const item = new vscode.TreeItem(entry.uri, vscode.TreeItemCollapsibleState.None);
    const progress = await this.getEntryPointProgress(entry.uri);
    item.description = progress === undefined
      ? entry.source
      : `${progress.audited}/${progress.total} audited`;
    item.contextValue = 'markedFile';
    item.resourceUri = entry.uri;
    item.tooltip = progress === undefined
      ? `${entry.uri.fsPath}\n${entry.source}`
      : `${entry.uri.fsPath}\n${progress.audited}/${progress.total} audited | ${entry.source}`;
    item.command = {
      command: 'solidityAuditor.openMarkedFile',
      title: 'Open Marked File',
      arguments: [entry]
    };
    return item;
  }

  async getChildren(): Promise<MarkedEntry[]> {
    return this.getEntries({ applyFilter: true });
  }

  getMarkedEntries(options?: { applyFilter?: boolean }): Promise<MarkedEntry[]> {
    return this.getEntries({ applyFilter: options?.applyFilter ?? false });
  }

  isEntryPointFilterEnabled(): boolean {
    return this.filterMode === 'entrypoints';
  }

  async toggleEntryPointFilter(): Promise<void> {
    this.filterMode = this.filterMode === 'all' ? 'entrypoints' : 'all';
    await this.persist();
    this.refresh();
  }

  async clearCachedAnalysisSnapshots(): Promise<void> {
    this.entryPointProgressCache.clear();
    await this.stateManager.clearEntryPointSnapshots();
    this.refresh();
  }

  refreshEntryPointCounts(uri?: vscode.Uri | vscode.Uri[]): void {
    if (!uri) {
      this.entryPointProgressCache.clear();
    } else if (Array.isArray(uri)) {
      for (const item of uri) {
        this.entryPointProgressCache.delete(item.toString());
      }
    } else {
      this.entryPointProgressCache.delete(uri.toString());
    }

    this.refresh(uri);
  }

  async provideFileDecoration(uri: vscode.Uri): Promise<vscode.FileDecoration | undefined> {
    if (!this.isMarked(uri)) {
      return undefined;
    }

    return new vscode.FileDecoration('📌', 'Marked for audit', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
  }

  isMarked(uri: vscode.Uri): boolean {
    const key = this.toKey(uri);

    if (this.manualFiles.has(key)) {
      return true;
    }
    if (this.excludedFiles.has(key)) {
      return false;
    }
    if (this.scopeFiles.has(key)) {
      return true;
    }
    return false;
  }

  async toggleFile(uri: vscode.Uri): Promise<void> {
    const key = this.toKey(uri);
    if (this.isMarked(uri)) {
      this.manualFiles.delete(key);
      this.excludedFiles.add(key);
    } else {
      this.manualFiles.add(key);
      this.excludedFiles.delete(key);
    }
    await this.persist();
    this.entryPointProgressCache.delete(uri.toString());
    this.refresh(uri);
  }

  async toggleFolder(uri: vscode.Uri): Promise<void> {
    const files = await listFilesRecursively(uri);
    if (files.length === 0) {
      return;
    }

    const allMarked = files.every((fileUri) => this.isMarked(fileUri));
    for (const fileUri of files) {
      const key = this.toKey(fileUri);
      if (allMarked) {
        this.manualFiles.delete(key);
        this.excludedFiles.add(key);
      } else {
        this.manualFiles.add(key);
        this.excludedFiles.delete(key);
      }
      this.entryPointProgressCache.delete(fileUri.toString());
    }
    await this.persist();
    this.refresh(files);
  }

  async toggleEntry(entry: MarkedEntry): Promise<void> {
    await this.toggleFile(entry.uri);
  }

  async reloadScopeMarks(): Promise<void> {
    const scopeFiles = new Set<string>();

    const scopeUris = await vscode.workspace.findFiles('**/SCOPE.md', '**/node_modules/**');
    for (const scopeUri of scopeUris) {
      const text = Buffer.from(await vscode.workspace.fs.readFile(scopeUri)).toString('utf8');
      const candidates = extractScopeCandidates(text);
      for (const candidate of candidates) {
        const resolved = await resolveScopeCandidate(scopeUri, candidate);
        if (!resolved) {
          continue;
        }

        const key = this.toKey(resolved.uri);
        if (resolved.kind === 'folder') {
          for (const fileUri of await listFilesRecursively(resolved.uri)) {
            scopeFiles.add(this.toKey(fileUri));
          }
        } else {
          scopeFiles.add(key);
        }
      }
    }

    this.scopeFiles = scopeFiles;
    this.entryPointProgressCache.clear();
    this.refresh();
  }

  private async getEntries(options?: { applyFilter?: boolean }): Promise<MarkedEntry[]> {
    const entries = new Map<string, MarkedEntry>();

    for (const key of this.scopeFiles) {
      if (this.excludedFiles.has(key)) {
        continue;
      }
      entries.set(`file:${key}`, {
        kind: 'file',
        source: 'scope',
        key,
        uri: this.toUri(key)
      });
    }

    for (const key of this.manualFiles) {
      entries.set(`file:${key}`, {
        kind: 'file',
        source: 'manual',
        key,
        uri: this.toUri(key)
      });
    }

    const sortedEntries = Array.from(entries.values()).sort((left, right) => left.key.localeCompare(right.key));
    if (!options?.applyFilter || this.filterMode === 'all') {
      return sortedEntries;
    }

    const filteredEntries = await Promise.all(
      sortedEntries.map(async (entry) => ((await this.getEntryPointProgress(entry.uri))?.total ?? 0) > 0 ? entry : undefined)
    );
    return filteredEntries.filter((entry): entry is MarkedEntry => Boolean(entry));
  }

  private toKey(uri: vscode.Uri): string {
    return normalizeKey(vscode.workspace.asRelativePath(uri, false));
  }

  private toUri(key: string): vscode.Uri {
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      return vscode.Uri.file(key);
    }
    return vscode.Uri.file(path.join(workspaceFolder.uri.fsPath, key));
  }

  private async persist(): Promise<void> {
    await this.stateManager.setMarkedState({
      manualFiles: Array.from(this.manualFiles),
      excludedFiles: Array.from(this.excludedFiles),
      filterMode: this.filterMode,
      legacyManualFolders: [],
      legacyExcludedFolders: []
    });
  }

  private async migrateLegacyFolderMarks(manualFolders: Set<string>, excludedFolders: Set<string>): Promise<void> {
    if (manualFolders.size === 0 && excludedFolders.size === 0) {
      return;
    }

    for (const folderKey of manualFolders) {
      for (const fileUri of await listFilesRecursively(this.toUri(folderKey))) {
        this.manualFiles.add(this.toKey(fileUri));
      }
    }

    for (const folderKey of excludedFolders) {
      for (const fileUri of await listFilesRecursively(this.toUri(folderKey))) {
        const key = this.toKey(fileUri);
        this.manualFiles.delete(key);
        this.excludedFiles.add(key);
      }
    }

    await this.persist();
  }

  async getEntryPointProgress(uri: vscode.Uri): Promise<{ audited: number; total: number } | undefined> {
    if (!uri.fsPath.endsWith('.sol')) {
      return undefined;
    }

    const cacheKey = uri.toString();
    const cached = this.entryPointProgressCache.get(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    if (!isSolidityDocument(document)) {
      return undefined;
    }

    const fileKey = this.toKey(uri);
    const activeEditor = vscode.window.activeTextEditor;
    const useActiveSelection = Boolean(activeEditor && activeEditor.document.uri.toString() === uri.toString());
    if (!useActiveSelection) {
      const snapshot = await this.getPersistedEntryPointSnapshot(uri, fileKey);
      if (snapshot) {
        const progress = this.buildEntryPointProgress(fileKey, snapshot.entryPointIds);
        this.entryPointProgressCache.set(cacheKey, progress);
        return progress;
      }
    }

    const analysis = await analyzeActiveContract(
      document,
      useActiveSelection ? activeEditor!.selection.active : new vscode.Position(0, 0)
    );
    const entryPointIds = (analysis?.cockpitItems ?? []).map((entryPoint) => entryPoint.id);
    const progress = this.buildEntryPointProgress(fileKey, entryPointIds);
    this.entryPointProgressCache.set(cacheKey, progress);
    await this.persistEntryPointSnapshot(uri, fileKey, entryPointIds);
    return progress;
  }

  private buildEntryPointProgress(fileKey: string, entryPointIds: string[]): { audited: number; total: number } {
    const trackedIds = new Set(this.stateManager.getTrackerState().auditedEntryIds);
    return {
      audited: entryPointIds.filter((entryPointId) => trackedIds.has(`${fileKey}::${entryPointId}`)).length,
      total: entryPointIds.length
    };
  }

  private async getPersistedEntryPointSnapshot(
    uri: vscode.Uri,
    fileKey: string
  ): Promise<{ mtime: number; size: number; entryPointIds: string[] } | undefined> {
    const snapshot = this.stateManager.getEntryPointSnapshot(fileKey);
    if (!snapshot) {
      return undefined;
    }

    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.mtime !== snapshot.mtime || stat.size !== snapshot.size) {
        return undefined;
      }
    } catch {
      return undefined;
    }

    return snapshot;
  }

  private async persistEntryPointSnapshot(uri: vscode.Uri, fileKey: string, entryPointIds: string[]): Promise<void> {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      await this.stateManager.setEntryPointSnapshot(fileKey, {
        mtime: stat.mtime,
        size: stat.size,
        entryPointIds
      });
    } catch {
      // Ignore cache persistence failures; live analysis result is already available.
    }
  }

  private refresh(uri?: vscode.Uri | vscode.Uri[]): void {
    this.treeEmitter.fire();
    this.decorationEmitter.fire(uri);
  }
}

function normalizeKey(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function extractScopeCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const patterns = [
    /\[[^\]]+\]\(([^)]+)\)/g,
    /`([^`]+)`/g,
    /(?:\.{0,2}\/)?[A-Za-z0-9_@][A-Za-z0-9_./-]*(?:\/|(?:\.[A-Za-z0-9]+))/g
  ];

  for (const pattern of patterns) {
    let match: RegExpExecArray | null = pattern.exec(text);
    while (match) {
      candidates.add(match[1] ?? match[0]);
      match = pattern.exec(text);
    }
  }

  return Array.from(candidates);
}

async function resolveScopeCandidate(
  scopeUri: vscode.Uri,
  candidate: string
): Promise<{ uri: vscode.Uri; kind: 'file' | 'folder' } | undefined> {
  const clean = candidate.trim().replace(/[),.:;]+$/, '');
  if (!clean || clean.includes('://')) {
    return undefined;
  }

  const candidateUris: vscode.Uri[] = [];
  if (path.isAbsolute(clean)) {
    candidateUris.push(vscode.Uri.file(clean));
  } else {
    candidateUris.push(vscode.Uri.file(path.resolve(path.dirname(scopeUri.fsPath), clean)));
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      candidateUris.push(vscode.Uri.file(path.resolve(folder.uri.fsPath, clean)));
    }
  }

  for (const uri of candidateUris) {
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.type === vscode.FileType.Directory) {
        return { uri, kind: 'folder' };
      }
      if (stat.type === vscode.FileType.File) {
        return { uri, kind: 'file' };
      }
    } catch {
      // Ignore missing candidates.
    }
  }

  return undefined;
}

async function listFilesRecursively(uri: vscode.Uri): Promise<vscode.Uri[]> {
  const files: vscode.Uri[] = [];

  const visit = async (current: vscode.Uri): Promise<void> => {
    let entries: [string, vscode.FileType][];
    try {
      entries = await vscode.workspace.fs.readDirectory(current);
    } catch {
      return;
    }

    for (const [name, type] of entries) {
      const child = vscode.Uri.file(path.join(current.fsPath, name));
      if ((type & vscode.FileType.Directory) !== 0) {
        await visit(child);
        continue;
      }
      if ((type & vscode.FileType.File) !== 0) {
        files.push(child);
      }
    }
  };

  await visit(uri);
  return files;
}

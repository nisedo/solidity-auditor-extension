import * as path from 'node:path';
import * as vscode from 'vscode';

const STORAGE_KEYS = {
  manualFiles: 'marked.manualFiles',
  manualFolders: 'marked.manualFolders',
  excludedFiles: 'marked.excludedFiles',
  excludedFolders: 'marked.excludedFolders'
};

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

  private manualFiles = new Set<string>();
  private manualFolders = new Set<string>();
  private excludedFiles = new Set<string>();
  private excludedFolders = new Set<string>();
  private scopeFiles = new Set<string>();
  private scopeFolders = new Set<string>();

  readonly onDidChangeTreeData = this.treeEmitter.event;
  readonly onDidChangeFileDecorations = this.decorationEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.scopeWatcher = vscode.workspace.createFileSystemWatcher('**/SCOPE.md');
    this.scopeWatcher.onDidChange(() => void this.reloadScopeMarks(), this, context.subscriptions);
    this.scopeWatcher.onDidCreate(() => void this.reloadScopeMarks(), this, context.subscriptions);
    this.scopeWatcher.onDidDelete(() => void this.reloadScopeMarks(), this, context.subscriptions);
  }

  async initialize(): Promise<void> {
    this.manualFiles = new Set(this.context.workspaceState.get<string[]>(STORAGE_KEYS.manualFiles, []));
    this.manualFolders = new Set(this.context.workspaceState.get<string[]>(STORAGE_KEYS.manualFolders, []));
    this.excludedFiles = new Set(this.context.workspaceState.get<string[]>(STORAGE_KEYS.excludedFiles, []));
    this.excludedFolders = new Set(this.context.workspaceState.get<string[]>(STORAGE_KEYS.excludedFolders, []));
    await this.reloadScopeMarks();
  }

  dispose(): void {
    this.scopeWatcher.dispose();
    this.treeEmitter.dispose();
    this.decorationEmitter.dispose();
  }

  getTreeItem(entry: MarkedEntry): vscode.TreeItem {
    const item = new vscode.TreeItem(entry.uri, entry.kind === 'folder' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.None);
    item.description = entry.source;
    item.contextValue = entry.kind === 'folder' ? 'markedFolder' : 'markedFile';
    item.resourceUri = entry.uri;
    item.command =
      entry.kind === 'folder'
        ? {
            command: 'revealInExplorer',
            title: 'Reveal In Explorer',
            arguments: [entry.uri]
          }
        : {
            command: 'vscode.open',
            title: 'Open File',
            arguments: [entry.uri]
          };
    return item;
  }

  getChildren(): MarkedEntry[] {
    return this.getEntries();
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
    if (isWithinFolderSet(key, this.excludedFolders)) {
      return false;
    }
    if (isWithinFolderSet(key, this.manualFolders)) {
      return true;
    }
    if (this.scopeFiles.has(key)) {
      return true;
    }
    if (isWithinFolderSet(key, this.scopeFolders)) {
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
    this.refresh(uri);
  }

  async toggleFolder(uri: vscode.Uri): Promise<void> {
    const key = this.toKey(uri);
    if (this.isMarked(uri)) {
      this.manualFolders.delete(key);
      this.excludedFolders.add(key);
    } else {
      this.manualFolders.add(key);
      this.excludedFolders.delete(key);
    }
    await this.persist();
    this.refresh(uri);
  }

  async toggleEntry(entry: MarkedEntry): Promise<void> {
    if (entry.kind === 'folder') {
      await this.toggleFolder(entry.uri);
      return;
    }
    await this.toggleFile(entry.uri);
  }

  async reloadScopeMarks(): Promise<void> {
    const scopeFiles = new Set<string>();
    const scopeFolders = new Set<string>();

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
          scopeFolders.add(key);
        } else {
          scopeFiles.add(key);
        }
      }
    }

    this.scopeFiles = scopeFiles;
    this.scopeFolders = scopeFolders;
    this.refresh();
  }

  private getEntries(): MarkedEntry[] {
    const entries = new Map<string, MarkedEntry>();

    for (const key of this.scopeFolders) {
      if (this.excludedFolders.has(key)) {
        continue;
      }
      entries.set(`folder:${key}`, {
        kind: 'folder',
        source: 'scope',
        key,
        uri: this.toUri(key)
      });
    }

    for (const key of this.scopeFiles) {
      if (this.excludedFiles.has(key) || isWithinFolderSet(key, this.excludedFolders)) {
        continue;
      }
      entries.set(`file:${key}`, {
        kind: 'file',
        source: 'scope',
        key,
        uri: this.toUri(key)
      });
    }

    for (const key of this.manualFolders) {
      entries.set(`folder:${key}`, {
        kind: 'folder',
        source: 'manual',
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

    return Array.from(entries.values()).sort((left, right) => left.key.localeCompare(right.key));
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
    await Promise.all([
      this.context.workspaceState.update(STORAGE_KEYS.manualFiles, Array.from(this.manualFiles)),
      this.context.workspaceState.update(STORAGE_KEYS.manualFolders, Array.from(this.manualFolders)),
      this.context.workspaceState.update(STORAGE_KEYS.excludedFiles, Array.from(this.excludedFiles)),
      this.context.workspaceState.update(STORAGE_KEYS.excludedFolders, Array.from(this.excludedFolders))
    ]);
  }

  private refresh(uri?: vscode.Uri): void {
    this.treeEmitter.fire();
    this.decorationEmitter.fire(uri);
  }
}

function isWithinFolderSet(target: string, folders: Set<string>): boolean {
  for (const folder of folders) {
    if (target === folder || target.startsWith(`${folder}/`)) {
      return true;
    }
  }
  return false;
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

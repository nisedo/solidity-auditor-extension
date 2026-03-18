# Solidity Auditor Extension

Minimal Solidity audit helpers for VS Code and Cursor.

This extension bundles a focused set of features that are useful during manual smart-contract review without pulling in a larger Solidity auditing extension suite.

## Features

- `Tracker` view for the active marked Solidity file:
  - follows the active contract under your cursor
  - lists public and external state-changing entry points
  - includes inherited entry points when they can be resolved locally
  - lets you mark entry points as audited
  - can filter to show only unaudited entry points
  - stores the last audited timestamp per entry point
- `Variables` view for the active contract:
  - lists mutable state variables only
  - includes inherited variables when they can be resolved locally
  - shows which entry points can modify each variable
  - shows `initialized in constructor` when a variable has no runtime modifying entry points
- `Marked Files` view:
  - mark and unmark files
  - toggle all files inside a folder from the folder context menu
  - auto-load marks from `SCOPE.md`
  - show marked files with a `📌` Explorer decoration
  - show per-file audit progress as `x/y audited`
  - can filter to show only files with entry points
- Progress reporting:
  - generate `.vscode/<repo>-audit-progress.md`
  - includes overall progress, unaudited files sorted by remaining work, and daily activity
- Diagnostics:
  - unused imports
  - unused local variables
  - unused private functions
- Editor hints:
  - mutable state variable highlighting
  - inlay hints for function parameter names
  - inlay hints for positional struct construction
  - inlay hints for constant values
  - inlay hints for event and custom error arguments

## Install

```bash
git clone https://github.com/nisedo/solidity-auditor-extension.git && cd solidity-auditor-extension && npm install && npx @vscode/vsce package && code --install-extension solidity-auditor-extension-0.0.1.vsix
```

## Usage

- Open a Solidity file.
- Use the `Solidity Auditor` activity-bar panel to access:
  - `Tracker`
  - `Variables`
  - `Marked Files`
- Use the Explorer context menu to toggle marks on files, or to toggle all files inside a folder.
- Keep a `SCOPE.md` in the workspace if you want marks to auto-load on activation.
- Use the `Tracker` title-bar filter to show all or only unaudited entry points.
- Use `Solidity Auditor: Show Progress Report` to generate the markdown audit-progress report.
- Use `Solidity Auditor: Clear Cached Analysis Snapshots` if you want to discard cached file analysis without clearing audit state.

## Notes

- The extension does not depend on an external Solidity language server for its own features.
- It parses Solidity source directly and resolves locally available imports, including common Foundry remappings.
- Some analyses are intentionally conservative to keep the implementation small and predictable.
- State is persisted in `.vscode/solidity-auditor-extension.json`.

## Current Limitations

- Diagnostics and hints are source-based, not compiler-accurate.
- Unused private function detection is conservative around overloads.
- Inlay hints only appear when the callee or struct definition can be resolved from locally available source.

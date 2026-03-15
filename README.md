# Solidity Auditor Extension

Minimal Solidity audit helpers for VS Code and Cursor.

This extension bundles a focused set of features that are useful during manual smart-contract review without pulling in a larger Solidity auditing extension suite.

## Features

- `Cockpit` view for the active contract:
  - lists public and external state-changing entry points
  - includes inherited entry points when they can be resolved locally
  - shows how many state variables each entry point can modify
- `Variables` view for the active contract:
  - lists mutable state variables only
  - includes inherited variables when they can be resolved locally
  - shows which entry points can modify each variable
- `Marked Files` view:
  - mark and unmark files
  - toggle all files inside a folder from the folder context menu
  - auto-load marks from `SCOPE.md`
  - show marked files with a `📌` Explorer decoration
- Diagnostics:
  - unused imports
  - unused local variables
  - unused private functions
- Editor hints:
  - mutable state variable highlighting
  - inlay hints for function parameter names
  - inlay hints for positional struct construction
  - inlay hints for constant values

## Install

```bash
git clone https://github.com/nisedo/solidity-auditor-extension.git && cd solidity-auditor-extension && npm install && npx @vscode/vsce package && code --install-extension solidity-auditor-extension-0.0.1.vsix
```

## Usage

- Open a Solidity file.
- Use the `Solidity Auditor` activity-bar panel to access:
  - `Cockpit`
  - `Variables`
  - `Marked Files`
- Use the Explorer context menu to toggle marks on files, or to toggle all files inside a folder.
- Keep a `SCOPE.md` in the workspace if you want marks to auto-load on activation.

## Notes

- The extension does not depend on an external Solidity language server for its own features.
- It parses Solidity source directly and resolves locally available imports, including common Foundry remappings.
- Some analyses are intentionally conservative to keep the implementation small and predictable.

## Current Limitations

- Diagnostics and hints are source-based, not compiler-accurate.
- Unused private function detection is conservative around overloads.
- Inlay hints only appear when the callee or struct definition can be resolved from locally available source.
